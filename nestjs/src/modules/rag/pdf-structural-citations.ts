import type { Citation } from './citations';
import type { RegionBox } from '../documents/parsers/parsed-document';

type Segment = NonNullable<Citation['sourceSegments']>[number];
type Item = { page: number; box: RegionBox; source: Citation; chars: Map<number, { char: string; ids: Set<number> }> };
type Line = { page: number; y: number; height: number; text: string; parts: Segment[]; boxes: RegionBox[] };
const category = /^(?:实习经历|工作经历|工作经验|实习经验|项目经历|项目经验|教育背景|教育经历|专业技能|技术技能|个人技能|个人信息|自我评价|experience|projects|education|skills)$/i;
const sublabel = /^(?:项目背景|背景介绍|主要职责|技术亮点|项目介绍|工作内容|工作职责|项目职责|项目成果)[:：]?$/;

/** Build display paragraphs from native PDF structure, leaving raw retrieval/cursors intact. */
export function structuralPdfCitations<T extends Citation>(sources: T[]): T[] {
  const buckets = new Map<string, { original: T; slices: T[] }[]>();
  for (const source of sources) {
    if (source.location?.table || !/\.pdf$/i.test(source.filename) || !source.location?.anchors?.length ||
      source.location.anchors.some(a => a.kind !== 'native')) continue;
    const key = `${source.documentId}:${source.versionId}:${source.indexRevisionId}`;
    const slices = source.sourceSegments ? source.sourceSegments.map(part => ({ ...source,
      sourceSegments: undefined, sectionTitle: undefined, text: part.text, location: part.location,
      chunkId: part.chunkIds[0], chunkIds: part.chunkIds })) : [source];
    const bucket = buckets.get(key) || []; bucket.push({ original: source, slices }); buckets.set(key, bucket);
  }
  const replacement = new Map<T, T[]>(), consumed = new Set<T>();
  for (const native of buckets.values()) {
    const grouped = group(native.flatMap(entry => entry.slices));
    if (!grouped) continue;
    replacement.set(native[0].original, grouped);
    native.slice(1).forEach(entry => consumed.add(entry.original));
  }
  return sources.flatMap(source => consumed.has(source) ? [] : replacement.get(source) || [source]);
}

function group<T extends Citation>(sources: T[]): T[] | undefined {
  const items = new Map<string, Item>();
  for (const source of sources) {
    const location = source.location!;
    if (location.end - location.start !== source.text.length) return;
    const covered = new Set<number>();
    for (const anchor of location.anchors!) {
      const box = anchor.rects[0];
      if (anchor.rects.length !== 1 || !box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]) return;
      const key = `${anchor.page}:${box.map(n => n.toFixed(6)).join(':')}`;
      let item = items.get(key);
      if (!item) items.set(key, item = { page: anchor.page, box, source, chars: new Map() });
      for (let at = Math.max(anchor.start, location.start); at < Math.min(anchor.end, location.end); at++) {
        const char = source.text[at - location.start], old = item.chars.get(at);
        if (old && old.char !== char) return;
        const ids = old?.ids || new Set<number>();
        (source.chunkIds || [source.chunkId]).forEach(id => ids.add(id));
        item.chars.set(at, { char, ids }); covered.add(at - location.start);
      }
    }
    for (let at = 0; at < source.text.length; at++) if (/\S/.test(source.text[at]) && !covered.has(at)) return;
  }
  const rows: { page: number; y: number; center: number; height: number; items: Item[] }[] = [];
  for (const item of [...items.values()].filter(i => i.chars.size).sort((a, b) => a.page - b.page || a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    const center = (item.box[1] + item.box[3]) / 2, height = item.box[3] - item.box[1];
    const row = rows.find(r => r.page === item.page && Math.abs(r.center - center) <= Math.max(r.height, height) * .45);
    if (row) row.items.push(item);
    else rows.push({ page: item.page, y: item.box[1], center, height, items: [item] });
  }
  const lines: Line[] = rows.map(row => {
    row.items.sort((a, b) => a.box[0] - b.box[0]);
    let text = '', right: number | undefined;
    const parts: Segment[] = [];
    for (const item of row.items) {
      const chars = [...item.chars].sort(([a], [b]) => a - b);
      let segment: Segment | undefined;
      for (const [at, value] of chars) {
        if (!segment || at !== segment.location.end) {
          segment = { text: '', chunkIds: [], location: { ...item.source.location!, page: item.page,
            start: at, end: at, anchorVersion: 1, anchors: [] } };
          parts.push(segment);
        }
        segment.text += value.char; segment.location.end = at + 1;
        segment.chunkIds = [...new Set([...segment.chunkIds, ...value.ids])].sort((a, b) => a - b);
        segment.location.anchors = [{ page: item.page, start: segment.location.start, end: at + 1,
          kind: 'native', rects: [[...item.box]] }];
      }
      text += (right !== undefined && item.box[0] - right > .002 ? ' ' : '') + chars.map(([, v]) => v.char).join('');
      right = item.box[2];
    }
    return { page: row.page, y: row.y, height: row.height, text, parts, boxes: row.items.map(i => i.box) };
  }).sort((a, b) => a.page - b.page || a.y - b.y);
  // Do not invent a single reading sequence for parallel prose columns.
  for (const line of lines) {
    const runs: [number, number][] = [];
    for (const box of line.boxes) {
      const last = runs.at(-1);
      if (last && box[0] - last[1] <= .025) last[1] = Math.max(last[1], box[2]);
      else runs.push([box[0], box[2]]);
    }
    const prose = runs.filter(([x0, x1]) => {
      const text = line.parts.filter(part => {
        const box = part.location.anchors![0].rects[0];
        return box[0] >= x0 && box[2] <= x1;
      }).map(part => part.text).join('');
      return category.test(text.trim()) || (text.match(/[\u3400-\u9fff]/g)?.length || 0) >= 4 ||
        /[a-z]{3,}\s+[a-z]{3,}/i.test(text);
    });
    if (prose.some((run, i) => prose.slice(i + 1).some(other => other[0] - run[1] > .08))) return;
  }
  const metadataHeadings = new Set(sources.map(s => s.location?.heading).filter(Boolean));
  const namedHeading = (text: string) =>
    /(?:19|20)\d{2}[./年-]\d{1,2}(?:月)?\s*[-–—~～至]\s*(?:(?:19|20)\d{2}[./年-]\d{1,2}|至今|现在|present)\s*$/i.test(text) ||
    /(?:——|—)\s*[^。；，]{0,24}(?:实习生|工程师|设计师|开发人员|经理)/.test(text);
  const hasNamedBlocks = lines.some(line => line.text.length <= 100 && namedHeading(line.text.trim()));
  const heading = (line: Line) => {
    const text = line.text.trim();
    if (text.length > 100 || sublabel.test(text)) return false;
    return category.test(text) || metadataHeadings.has(text) ||
      namedHeading(text) ||
      (!hasNamedBlocks && text.length < 65 && !/[:：。；，]$/.test(text) && /^(?:第[一二三四五六七八九十\d]+[章节]|[一二三四五六七八九十]+、|\d+(?:\.\d+)*[.、]\s*\S)/.test(text));
  };
  if (!lines.some(heading)) return;
  const groups: { title: string; lines: Line[] }[] = [];
  let active: Line[] = [], title = '基本信息';
  const flush = () => { if (active.length) groups.push({ title, lines: active }); active = []; };
  for (const line of lines) {
    if (heading(line)) {
      if (!active.length || !active.every(row => category.test(row.text.trim()))) flush();
      title = line.text.trim();
    } else if (active.reduce((n, row) => n + row.text.length, 0) + line.text.length > 1800) flush();
    active.push(line);
  }
  flush();
  return groups.map(g => {
    const parts = g.lines.flatMap(line => line.parts), first = parts[0].location;
    const ids = [...new Set(parts.flatMap(p => p.chunkIds))].sort((a, b) => a - b);
    return { ...sources[0], number: 0, chunkId: ids[0], chunkIds: ids, sectionTitle: g.title,
      text: g.lines.map(line => line.text).join('\n'), sourceSegments: parts,
      location: { ...first, heading: g.title, start: Math.min(...parts.map(p => p.location.start)),
        end: Math.max(...parts.map(p => p.location.end)), anchorVersion: 1,
        anchors: parts.flatMap(p => p.location.anchors || []) } };
  });
}
