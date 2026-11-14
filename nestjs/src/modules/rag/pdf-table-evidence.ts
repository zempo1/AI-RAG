import type { Citation } from './citations';
import type { PdfTableLocation, RegionBox } from '../documents/parsers/parsed-document';
import { mergeSourceLocations, sliceSourceLocation } from '../documents/parsers/source-anchors';

export function tableRegions(source: Citation) {
  return (
    source.tableRegions ||
    (source.location?.table && source.location.page
      ? [{ page: source.location.page, table: source.location.table }]
      : [])
  );
}
const inside = (box: RegionBox, table: PdfTableLocation) => {
  const x = (box[0] + box[2]) / 2,
    y = (box[1] + box[3]) / 2;
  return x >= table.bbox[0] && x <= table.bbox[2] && y >= table.bbox[1] && y <= table.bbox[3];
};

/** Clip legacy page-wide chunks into exact contiguous table/non-table ranges. */
export function splitTableSource<T extends Citation>(source: T): T[] {
  const location = source.location,
    regions = tableRegions(source);
  if (
    source.sourceSegments ||
    location?.table ||
    !regions.length ||
    !location?.anchors?.length ||
    location.anchors.some((a) => a.kind !== 'native') ||
    source.text.length !== location.end - location.start
  )
    return [source];
  const result: T[] = [];
  let start = location.start,
    current: PdfTableLocation | undefined;
  const append = (end: number) => {
    const text = source.text.slice(start - location.start, end - location.start);
    if (!text.trim()) return;
    const { tableRegions: _regions, ...base } = source;
    const sliced = sliceSourceLocation(location, start, end);
    result.push({
      ...base,
      text,
      location: {
        ...sliced,
        page: sliced.anchors?.[0]?.page ?? location.page,
        table: current,
        ...(current?.title ? { heading: current.title } : {}),
      },
    } as T);
  };
  for (const anchor of [...location.anchors].sort((a, b) => a.start - b.start)) {
    const next = regions.find(
      (r) => r.page === anchor.page && anchor.rects.every((box) => inside(box, r.table)),
    )?.table;
    if (next?.id !== current?.id) {
      append(anchor.start);
      start = anchor.start;
      current = next;
    }
  }
  append(location.end);
  return result;
}

type Part = NonNullable<Citation['sourceSegments']>[number];
type Item = {
  page: number;
  box: RegionBox;
  table: PdfTableLocation;
  source: Citation;
  chars: Map<number, { char: string; ids: number[] }>;
};

function cellText(cell: { box: RegionBox; text: string }[]) {
  const lines: { y: number; center: number; height: number; items: typeof cell }[] = [];
  for (const item of cell) {
    const center = (item.box[1] + item.box[3]) / 2,
      height = item.box[3] - item.box[1];
    const line = lines.find(
      (row) => Math.abs(row.center - center) <= Math.max(row.height, height) * 0.45,
    );
    if (line) line.items.push(item);
    else lines.push({ y: item.box[1], center, height, items: [item] });
  }
  return lines
    .sort((a, b) => a.y - b.y)
    .map((line) =>
      line.items
        .sort((a, b) => a.box[0] - b.box[0])
        .map(
          (item, i, all) => (i && item.box[0] - all[i - 1].box[2] > 0.003 ? ' ' : '') + item.text,
        )
        .join(''),
    )
    .join(' ')
    .trim();
}

/** A logical table is atomic for context packing and may contain anchors from several pages. */
export function joinTableSources<T extends Citation>(sources: T[]): T[] {
  const buckets = new Map<string, T[]>();
  for (const source of sources) {
    const table = source.location?.table;
    if (!table) continue;
    const key = `${source.documentId}:${source.versionId}:${source.indexRevisionId}:${table.groupId}`;
    const bucket = buckets.get(key) || [];
    bucket.push(source);
    buckets.set(key, bucket);
  }
  const replacement = new Map<T, T>(),
    consumed = new Set<T>();
  for (const bucket of buckets.values()) {
    const joined = build(bucket) || rawSnapshot(bucket);
    if (!joined) continue;
    replacement.set(bucket[0], joined);
    bucket.slice(1).forEach((s) => consumed.add(s));
  }
  return sources.flatMap((source) =>
    consumed.has(source) ? [] : [replacement.get(source) || source],
  );
}

function snapshot<T extends Citation>(sources: T[], text: string, parts: Part[]): T {
  const ids = [...new Set(parts.flatMap((p) => p.chunkIds))].sort((a, b) => a - b);
  const { tableRegions: _regions, ...base } = sources[0];
  return {
    ...base,
    text,
    sectionTitle: parts[0].location.table?.title || '表格原文',
    sourceSegments: parts,
    chunkId: ids[0],
    chunkIds: ids,
    location: {
      ...parts[0].location,
      start: Math.min(...parts.map((p) => p.location.start)),
      end: Math.max(...parts.map((p) => p.location.end)),
      anchors: parts.flatMap((p) => p.location.anchors || []),
    },
  } as T;
}

/** Missing item geometry must not turn one logical table back into separately packed pages. */
function rawSnapshot<T extends Citation>(sources: T[]): T | undefined {
  if (sources.length < 2) return;
  const parts = new Map<string, Part>();
  for (const source of sources) {
    const slices =
      source.sourceSegments ||
      (source.location
        ? [
            {
              text: source.text,
              location: source.location,
              chunkIds: source.chunkIds || [source.chunkId],
            },
          ]
        : []);
    if (!slices.length) return;
    for (const part of slices) {
      if (part.text.length !== part.location.end - part.location.start) return;
      const key = `${part.location.page}:${part.location.start}:${part.location.end}:${part.text}`;
      const old = parts.get(key);
      parts.set(key, {
        ...part,
        location: old ? mergeSourceLocations(old.location, part.location) : part.location,
        chunkIds: [...new Set([...(old?.chunkIds || []), ...part.chunkIds])],
      });
    }
  }
  const ordered = [...parts.values()].sort(
    (a, b) =>
      (a.location.page || 0) - (b.location.page || 0) || a.location.start - b.location.start,
  );
  const merged: Part[] = [];
  for (const part of ordered) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.location.page === part.location.page &&
      previous.location.table?.id === part.location.table?.id &&
      part.location.start <= previous.location.end
    ) {
      const offset = part.location.start - previous.location.start;
      const overlap = Math.min(previous.location.end, part.location.end) - part.location.start;
      if (previous.text.slice(offset, offset + overlap) === part.text.slice(0, overlap)) {
        merged[merged.length - 1] = {
          text: previous.text + part.text.slice(overlap),
          chunkIds: [...new Set([...previous.chunkIds, ...part.chunkIds])].sort((a, b) => a - b),
          location: mergeSourceLocations(previous.location, part.location),
        };
        continue;
      }
    }
    merged.push(part);
  }
  return snapshot(sources, merged.map((p) => p.text).join('\n\n'), merged);
}

function build<T extends Citation>(sources: T[]): T | undefined {
  const items = new Map<string, Item>(),
    tables = new Map<number, PdfTableLocation>();
  const slices = sources.flatMap((source) =>
    source.sourceSegments
      ? source.sourceSegments.map((part) => ({
          ...source,
          ...part,
          chunkId: part.chunkIds[0],
          sourceSegments: undefined,
        }))
      : [source],
  );
  for (const source of slices) {
    const loc = source.location,
      table = loc?.table;
    if (!loc || !table || !loc.anchors?.length || source.text.length !== loc.end - loc.start)
      return;
    const covered = new Set<number>();
    for (const anchor of loc.anchors) {
      if (anchor.kind !== 'native' || anchor.rects.length !== 1 || !inside(anchor.rects[0], table))
        return;
      const box = anchor.rects[0],
        key = `${anchor.page}:${box.map((n) => n.toFixed(6))}`;
      tables.set(anchor.page, table);
      let item = items.get(key);
      if (!item)
        items.set(key, (item = { page: anchor.page, box, table, source, chars: new Map() }));
      for (let at = Math.max(anchor.start, loc.start); at < Math.min(anchor.end, loc.end); at++) {
        const char = source.text[at - loc.start],
          old = item.chars.get(at);
        if (old && old.char !== char) return;
        item.chars.set(at, {
          char,
          ids: [...new Set([...(old?.ids || []), ...(source.chunkIds || [source.chunkId])])].sort(
            (a, b) => a - b,
          ),
        });
        covered.add(at - loc.start);
      }
    }
    // Geometry is optional for legacy content. Never replace a source with a
    // reconstructed table if doing so would silently drop any actual text.
    for (let at = 0; at < source.text.length; at++) {
      if (/\S/u.test(source.text[at]) && !covered.has(at)) return;
    }
  }
  const parts: Part[] = [],
    rows: string[][] = [];
  const pages = [...tables.keys()].sort((a, b) => a - b);
  for (const page of pages) {
    const table = tables.get(page)!,
      count = table.columns.length - 1;
    if (count < 2 || table.rows.length < 2 || (rows[0] && rows[0].length !== count)) return;
    const cells: { box: RegionBox; text: string }[][][] = Array.from(
      { length: table.rows.length - 1 },
      () => Array.from({ length: count }, () => []),
    );
    for (const item of [...items.values()]
      .filter((i) => i.page === page)
      .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
      const x = (item.box[0] + item.box[2]) / 2,
        y = (item.box[1] + item.box[3]) / 2;
      const column = table.columns.findIndex(
        (v, i) => i < count && x >= v && x <= table.columns[i + 1],
      );
      const row = table.rows.findIndex(
        (v, i) => i < table.rows.length - 1 && y >= v && y <= table.rows[i + 1],
      );
      if (
        column < 0 ||
        row < 0 ||
        item.box[0] < table.columns[column] - 0.008 ||
        item.box[2] > table.columns[column + 1] + 0.008
      )
        return;
      const chars = [...item.chars].sort(([a], [b]) => a - b);
      cells[row][column].push({ box: item.box, text: chars.map(([, v]) => v.char).join('') });
      let part: Part | undefined;
      for (const [at, value] of chars) {
        if (!part || at !== part.location.end) {
          part = {
            text: '',
            chunkIds: [],
            location: {
              ...item.source.location!,
              table,
              page,
              start: at,
              end: at,
              anchorVersion: 1,
              anchors: [],
            },
          };
          parts.push(part);
        }
        part.text += value.char;
        part.location.end = at + 1;
        part.chunkIds = [...new Set([...part.chunkIds, ...value.ids])].sort((a, b) => a - b);
        part.location.anchors = [
          { page, start: part.location.start, end: at + 1, kind: 'native', rects: [[...item.box]] },
        ];
      }
    }
    for (const [index, row] of cells.entries()) {
      const values = row.map(cellText);
      if (!values.some(Boolean)) continue;
      if (page !== pages[0] && index === 0 && JSON.stringify(values) === JSON.stringify(rows[0]))
        continue;
      rows.push(values);
    }
  }
  if (!rows.length || !parts.length) return;
  const format = (row: string[]) =>
    '| ' + row.map((c) => c.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')).join(' | ') + ' |';
  const text = [
    format(rows[0]),
    format(rows[0].map(() => '---')),
    ...rows.slice(1).map(format),
  ].join('\n');
  return snapshot(sources, text, parts);
}
