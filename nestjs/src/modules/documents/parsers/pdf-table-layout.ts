import { createHash } from 'node:crypto';
import type { ParsedBlock, ParsedDocument, PdfTableLocation, RegionBox } from './parsed-document';
import type { TextPosition } from './pdf-layout';
import { sliceSourceLocation } from './source-anchors';

type Matrix = number[];
type Segment = { horizontal: boolean; at: number; start: number; end: number };
const TOLERANCE = 0.003;
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const clustered = (values: number[]) => {
  const clusters: number[][] = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = clusters.at(-1);
    if (last && value - last[0] <= TOLERANCE * 1.5) last.push(value);
    else clusters.push([value]);
  }
  return clusters.map((group) => (Math.min(...group) + Math.max(...group)) / 2);
};

/** PDF.js 6 packs typed DrawOPS and paint operation into constructPath arguments. */
export function detectPdfTableGrids(
  list: any,
  ops: any,
  viewport: any,
  pageNumber: number,
): PdfTableLocation[] {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const segments: Segment[] = [];
  const point = (x: number, y: number) => {
    const m = multiply(Array.from(viewport.transform), matrix);
    return [
      (m[0] * x + m[2] * y + m[4]) / viewport.width,
      (m[1] * x + m[3] * y + m[5]) / viewport.height,
    ];
  };
  const line = (a: number[], b: number[]) => {
    if (![...a, ...b].every(Number.isFinite)) return;
    const dx = Math.abs(a[0] - b[0]),
      dy = Math.abs(a[1] - b[1]);
    if (dy <= 0.0005 && dx >= 0.008)
      segments.push({
        horizontal: true,
        at: (a[1] + b[1]) / 2,
        start: Math.min(a[0], b[0]),
        end: Math.max(a[0], b[0]),
      });
    else if (dx <= 0.0005 && dy >= 0.008)
      segments.push({
        horizontal: false,
        at: (a[0] + b[0]) / 2,
        start: Math.min(a[1], b[1]),
        end: Math.max(a[1], b[1]),
      });
  };
  const stroke = new Set([
    ops.stroke,
    ops.closeStroke,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
  ]);
  for (let i = 0; i < list.fnArray.length; i++) {
    const op = list.fnArray[i],
      args = list.argsArray[i];
    if (op === ops.save || op === ops.paintFormXObjectBegin) {
      stack.push([...matrix]);
      if (op === ops.paintFormXObjectBegin && args?.[0])
        matrix = multiply(matrix, Array.from(args[0]));
      continue;
    }
    if (op === ops.restore || op === ops.paintFormXObjectEnd) {
      matrix = stack.pop() || matrix;
      continue;
    }
    if (op === ops.transform) {
      matrix = multiply(matrix, Array.from(args));
      continue;
    }
    if (op !== ops.constructPath || args?.[0] === ops.endPath || !args?.[2]) continue;
    const bounds = Array.from(args[2]) as number[];
    const corners = [
      point(bounds[0], bounds[1]),
      point(bounds[2], bounds[1]),
      point(bounds[0], bounds[3]),
      point(bounds[2], bounds[3]),
    ];
    const box = [
      Math.min(...corners.map((p) => p[0])),
      Math.min(...corners.map((p) => p[1])),
      Math.max(...corners.map((p) => p[0])),
      Math.max(...corners.map((p) => p[1])),
    ];
    const width = box[2] - box[0],
      height = box[3] - box[1];
    // Filled hairline rectangles are common Word/PDF table borders. Large fills are backgrounds.
    if (height <= TOLERANCE && width >= 0.008) {
      line([box[0], (box[1] + box[3]) / 2], [box[2], (box[1] + box[3]) / 2]);
      continue;
    }
    if (width <= TOLERANCE && height >= 0.008) {
      line([(box[0] + box[2]) / 2, box[1]], [(box[0] + box[2]) / 2, box[3]]);
      continue;
    }
    if (!stroke.has(args[0])) continue;
    const path = args[1]?.[0];
    if (!ArrayBuffer.isView(path) && !Array.isArray(path)) continue;
    const data = Array.from(path as ArrayLike<number>);
    let current: number[] | undefined, first: number[] | undefined;
    for (let n = 0; n < data.length;) {
      const command = data[n++];
      if (command === 0 || command === 1) {
        const next = point(data[n++], data[n++]);
        if (command === 0) first = next;
        else if (current) line(current, next);
        current = next;
      } else if (command === 2 || command === 3) {
        const count = command === 2 ? 6 : 4;
        current = point(data[n + count - 2], data[n + count - 1]);
        n += count;
      } else if (command === 4) {
        if (current && first) line(current, first);
        current = first;
      } else break;
    }
  }
  // Join border fragments, including the two parallel edges of a filled border.
  const merged: Segment[] = [];
  for (const segment of segments) {
    if (segment.at < 0 || segment.at > 1 || segment.end < 0 || segment.start > 1) continue;
    let value = { ...segment };
    for (let i = merged.length - 1; i >= 0; i--) {
      const other = merged[i];
      if (
        value.horizontal !== other.horizontal ||
        Math.abs(value.at - other.at) > TOLERANCE ||
        value.start > other.end + TOLERANCE ||
        other.start > value.end + TOLERANCE
      )
        continue;
      value = {
        ...value,
        at: (value.at + other.at) / 2,
        start: Math.min(value.start, other.start),
        end: Math.max(value.end, other.end),
      };
      merged.splice(i, 1);
    }
    merged.push(value);
  }
  const touching = (a: Segment, b: Segment) => {
    if (a.horizontal === b.horizontal) return false;
    const h = a.horizontal ? a : b,
      v = a.horizontal ? b : a;
    return (
      v.at >= h.start - TOLERANCE &&
      v.at <= h.end + TOLERANCE &&
      h.at >= v.start - TOLERANCE &&
      h.at <= v.end + TOLERANCE
    );
  };
  const remaining = new Set(merged);
  const grids: PdfTableLocation[] = [];
  while (remaining.size) {
    const group = [remaining.values().next().value!];
    remaining.delete(group[0]);
    for (let i = 0; i < group.length; i++)
      for (const segment of remaining)
        if (touching(group[i], segment)) {
          group.push(segment);
          remaining.delete(segment);
        }
    const columns = clustered(group.filter((s) => !s.horizontal).map((s) => s.at));
    const rows = clustered(group.filter((s) => s.horizontal).map((s) => s.at));
    if (columns.length < 3 || rows.length < 3) continue;
    const bbox: RegionBox = [columns[0], rows[0], columns.at(-1)!, rows.at(-1)!];
    if (
      Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) < 0.12 ||
      Math.min(bbox[2] - bbox[0], bbox[3] - bbox[1]) < 0.015 ||
      columns.some((x) => x < 0 || x > 1) ||
      rows.some((y) => y < 0 || y > 1)
    )
      continue;
    // Each boundary must span the grid. Fragmentary chart axes are insufficient evidence.
    if (
      columns.some((x) => {
        const lines = group.filter((s) => !s.horizontal && Math.abs(s.at - x) <= TOLERANCE * 1.5);
        return (
          Math.min(...lines.map((s) => s.start)) > bbox[1] + TOLERANCE * 2 ||
          Math.max(...lines.map((s) => s.end)) < bbox[3] - TOLERANCE * 2
        );
      })
    )
      continue;
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          pageNumber,
          columns.map((x) => +x.toFixed(4)),
          rows.map((y) => +y.toFixed(4)),
        ]),
      )
      .digest('hex')
      .slice(0, 20);
    const id = `pdf-table:${pageNumber}:${identity}`;
    grids.push({ id, groupId: id, bbox, columns, rows });
  }
  return grids.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

/** Absolute edges as well as relative column widths must agree; adjacent layouts alone do not link. */
export function tableColumnsMatch(
  left: Pick<PdfTableLocation, 'bbox' | 'columns'>,
  right: Pick<PdfTableLocation, 'bbox' | 'columns'>,
): boolean {
  return (
    left.columns.length >= 3 &&
    left.columns.length === right.columns.length &&
    left.columns.every((edge, i) => Math.abs(edge - right.columns[i]) <= 0.006) &&
    Math.abs(left.bbox[0] - right.bbox[0]) <= 0.006 &&
    Math.abs(left.bbox[2] - right.bbox[2]) <= 0.006
  );
}

/** Split at native item boundaries, never giving a table a hull over intervening prose. */
export function splitNativeTableBlocks(
  blocks: ParsedBlock[],
  grids: PdfTableLocation[],
  positions: TextPosition[],
  ranges: { start: number; end: number }[],
): ParsedBlock[] {
  const membership = positions.map(({ bbox: b, text }) =>
    text.trim()
      ? grids.find(
          ({ bbox: g }) =>
            (b[0] + b[2]) / 2 >= g[0] - TOLERANCE &&
            (b[0] + b[2]) / 2 <= g[2] + TOLERANCE &&
            (b[1] + b[3]) / 2 >= g[1] - TOLERANCE &&
            (b[1] + b[3]) / 2 <= g[3] + TOLERANCE,
        )
      : undefined,
  );
  const output: ParsedBlock[] = [];
  for (const block of blocks) {
    const items = ranges
      .map((range, index) => ({ ...range, index }))
      .filter(
        (range) =>
          range.end > block.location.start &&
          range.start < block.location.end &&
          positions[range.index]?.text.trim(),
      );
    if (!items.length) {
      output.push(block);
      continue;
    }
    let start = block.location.start,
      table = membership[items[0].index];
    const push = (end: number) => {
      const raw = block.text.slice(start - block.location.start, end - block.location.start);
      const leading = raw.length - raw.trimStart().length;
      const text = raw.trim();
      if (text)
        output.push({
          ...block,
          text,
          location: {
            ...sliceSourceLocation(block.location, start + leading, start + leading + text.length),
            ...(table ? { table } : {}),
          },
        });
      start = end;
    };
    for (const item of items.slice(1)) {
      const next = membership[item.index];
      if (next?.id !== table?.id) {
        push(item.start);
        table = next;
      }
    }
    push(block.location.end);
  }
  return output.map((block, index) => ({
    ...block,
    location: { ...block.location, paragraph: index + 1 },
  }));
}

const tableBlocks = (page: ParsedDocument) => page.blocks.filter((block) => block.location.table);
const marginalNumber = (text: string, box: RegionBox) =>
  /^\s*\d{1,4}\s*$/.test(text) && (box[3] <= 0.08 || box[1] >= 0.9);
function repeatedMargin(other: ParsedDocument | undefined, text: string, box: RegionBox) {
  if (!other || (box[3] > 0.08 && box[1] < 0.9)) return false;
  return other.blocks.some(
    (block) =>
      !block.location.table &&
      (block.location.anchors || []).some(
        (anchor) =>
          other.text.slice(anchor.start, anchor.end).trim() === text.trim() &&
          anchor.rects.some((candidate) =>
            candidate.every((value, i) => Math.abs(value - box[i]) <= TOLERANCE),
          ),
      ),
  );
}
function obstructed(
  page: ParsedDocument,
  table: PdfTableLocation,
  after: boolean,
  other?: ParsedDocument,
  allowUnverifiedFooter = false,
) {
  return page.blocks.some(
    (block) =>
      block.location.table?.id !== table.id &&
      (block.location.anchors || []).some((anchor) =>
        anchor.rects.some((box) => {
          const text = page.text.slice(anchor.start, anchor.end);
          return (
            text.trim() &&
            !marginalNumber(text, box) &&
            !(allowUnverifiedFooter && box[1] >= 0.9) &&
            !repeatedMargin(other, text, box) &&
            (after ? box[1] >= table.bbox[3] - TOLERANCE : box[3] <= table.bbox[1] + TOLERANCE)
          );
        }),
      ),
  );
}
function firstRow(page: ParsedDocument, table: PdfTableLocation): string[] {
  const cells = table.columns.slice(1).map(() => '');
  const anchors = tableBlocks(page)
    .filter((block) => block.location.table!.id === table.id)
    .flatMap((block) => block.location.anchors || []);
  for (const anchor of anchors) {
    const box = anchor.rects[0];
    if (!box || (box[1] + box[3]) / 2 > table.rows[1] + TOLERANCE) continue;
    const x = (box[0] + box[2]) / 2;
    const col = table.columns.findIndex(
      (edge, i) =>
        i < cells.length && x >= edge - TOLERANCE && x <= table.columns[i + 1] + TOLERANCE,
    );
    if (col >= 0)
      cells[col] += page.text.slice(anchor.start, anchor.end).replace(/\s/g, '').toLowerCase();
  }
  return cells;
}

/** Only mutate table metadata; page text, anchors and offsets stay untouched. */
export function linkAdjacentPageTables(previous: ParsedDocument, next: ParsedDocument): void {
  const leftBlocks = tableBlocks(previous),
    rightBlocks = tableBlocks(next);
  const left = leftBlocks.at(-1)?.location.table,
    right = rightBlocks[0]?.location.table;
  const from = leftBlocks.at(-1)?.location.page,
    to = rightBlocks[0]?.location.page;
  if (
    !left ||
    !right ||
    from == null ||
    to !== from + 1 ||
    left.bbox[3] < 0.72 ||
    right.bbox[1] > 0.2 ||
    !tableColumnsMatch(left, right) ||
    obstructed(previous, left, true, next) ||
    obstructed(next, right, false, previous)
  )
    return;
  const header = firstRow(previous, left),
    candidate = firstRow(next, right);
  const repeatedLabels = header.filter((cell, i) => cell && cell === candidate[i]).length;
  if (
    repeatedLabels >= 2 ||
    (header[0] && header[0] === candidate[0] && candidate.filter(Boolean).length >= 2)
  )
    return;
  for (const block of leftBlocks)
    if (block.location.table!.id === left.id)
      block.location.table = { ...block.location.table!, continuedTo: to };
  for (const block of rightBlocks)
    if (block.location.table!.id === right.id)
      block.location.table = {
        ...block.location.table!,
        groupId: left.groupId,
        continuedFrom: from,
      };
}

export function hasPageTailTable(page: ParsedDocument): boolean {
  const table = tableBlocks(page).at(-1)?.location.table;
  // Candidate selection cannot establish whether a text footer repeats yet.
  // Defer footer rejection to the strict comparison with the adjacent page.
  return Boolean(table && table.bbox[3] >= 0.72 && !obstructed(page, table, true, undefined, true));
}
