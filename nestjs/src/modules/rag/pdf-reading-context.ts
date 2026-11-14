import type { Citation } from './citations';
import type { RegionBox } from '../documents/parsers/parsed-document';

/** A presentation view only: citation text, offsets and saved snapshots never change. */
export function pdfReadingContext(sources: Citation[]): string | undefined {
  if (!sources.length || sources.some(s => !/\.pdf$/i.test(s.filename) || !s.location?.anchors?.length)) return undefined;
  const documents = new Set(sources.map(s => `${s.documentId}:${s.versionId}:${s.indexRevisionId}`));
  if (documents.size !== 1) return undefined;
  type Item = { page: number; box: RegionBox; text: string; numbers: number[] };
  const supplements: { page: number; source: Citation }[] = [];
  const items = new Map<string, { page: number; box: RegionBox; chars: Map<number, { text: string; number: number }> }>();
  for (const source of sources) {
    const anchors = source.location!.anchors!;
    if (anchors.some(anchor => anchor.kind !== 'native')) {
      const pages = new Set(anchors.map(anchor => anchor.page));
      if (pages.size !== 1) return undefined;
      // Recognition regions may span unrelated paragraphs or contain inferred
      // labels. Preserve their text, but do not mix them into native chronology.
      supplements.push({ page: anchors[0].page, source });
      continue;
    }
    const covered = new Set<number>();
    for (const anchor of source.location!.anchors!) {
      if (anchor.kind !== 'native' || anchor.rects.length !== 1) return undefined;
      const box = anchor.rects[0];
      if (!box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]) return undefined;
      const start = Math.max(anchor.start, source.location!.start);
      const end = Math.min(anchor.end, source.location!.end, source.location!.start + source.text.length);
      const key = `${anchor.page}:${box.map(v => v.toFixed(6)).join(':')}`;
      let item = items.get(key);
      if (!item) items.set(key, item = { page: anchor.page, box, chars: new Map() });
      for (let at = start; at < end; at++) {
        const index = at - source.location!.start, text = source.text[index];
        const previous = item.chars.get(at);
        if (previous && previous.text !== text) return undefined;
        if (!previous) item.chars.set(at, { text, number: source.number });
        covered.add(index);
      }
    }
    for (let i = 0; i < source.text.length; i++) if (!/\s/.test(source.text[i]) && !covered.has(i)) return undefined;
  }
  const positioned: Item[] = [...items.values()].filter(item => item.chars.size).map(item => {
    const chars = [...item.chars].sort(([a], [b]) => a - b).map(([, value]) => value);
    return { ...item, text: chars.map(c => c.text).join(''), numbers: [...new Set(chars.map(c => c.number))] };
  });
  if (!positioned.length) return undefined;
  const rows: { page: number; top: number; center: number; height: number; items: Item[] }[] = [];
  for (const item of positioned.sort((a, b) => a.page - b.page || a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    const center = (item.box[1] + item.box[3]) / 2, height = item.box[3] - item.box[1];
    const row = rows.find(row => row.page === item.page && Math.abs(row.center - center) <= Math.max(row.height, height) * 0.45);
    if (row) row.items.push(item);
    else rows.push({ page: item.page, top: item.box[1], center, height, items: [item] });
  }
  // Ambiguous parallel prose columns require a separate reading-order model.
  // Keep the established context rather than interleave those columns by line.
  const columnRows = new Map<number, number>();
  for (const row of rows) {
    row.items.sort((a, b) => a.box[0] - b.box[0]);
    const runs: [number, number][] = [];
    for (const { box } of row.items) {
      const previous = runs.at(-1);
      if (previous && box[0] - previous[1] <= 0.025) previous[1] = Math.max(previous[1], box[2]);
      else runs.push([box[0], box[2]]);
    }
    if (runs.filter(([left, right]) => right - left > 0.22).length >= 2)
      columnRows.set(row.page, (columnRows.get(row.page) || 0) + 1);
  }
  if ([...columnRows.values()].some(count => count >= 3)) return undefined;
  const lines: string[] = [];
  const pages = [...new Set([...rows.map(row => row.page), ...supplements.map(s => s.page)])].sort((a, b) => a - b);
  for (const page of pages) {
    lines.push(`文件：${sources[0].filename} 第${page}页（按版面阅读顺序）`);
    for (const row of rows.filter(row => row.page === page).sort((a, b) => a.top - b.top)) {
      let text = '', right: number | undefined;
      const numbers = new Set<number>();
      for (const item of row.items) {
        text += (right !== undefined && item.box[0] - right > 0.002 ? ' ' : '') + item.text;
        right = item.box[2]; item.numbers.forEach(number => numbers.add(number));
      }
      lines.push(text + [...numbers].map(number => `[${number}]`).join(''));
    }
    const recognized = supplements.filter(s => s.page === page);
    if (recognized.length) {
      lines.push('识别补充（OCR/模型结果）：若与本页原生文字冲突，以原生文字为准，不用识别补充改写原文已有的内容归属。');
      for (const { source } of recognized) lines.push(`[${source.number}] ${source.text}`);
    }
  }
  return lines.join('\n');
}
