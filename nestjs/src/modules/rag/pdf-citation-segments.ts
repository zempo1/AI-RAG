import type { Citation } from './citations';
import { sliceSourceLocation } from '../documents/parsers/source-anchors';

/** Retrieval chunks are context windows; independent paragraphs need independent citations. */
export function splitPdfCitation<T extends Citation>(source: T): T[] {
  const { location, text } = source;
  if (!/\.pdf$/i.test(source.filename) || location?.anchorVersion !== 1 ||
    !location.anchors?.length || location.end - location.start !== text.length ||
    location.anchors.some(a => a.kind === 'region')) return [source];
  const anchors = [...location.anchors].sort((a, b) => a.start - b.start || a.end - b.end);
  if (anchors.some(a => !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) ||
    a.end <= a.start || !a.rects.length || a.rects.some(r => !r.every(Number.isFinite)))) return [source];
  // The parser deliberately gives generated OCR labels no geometry. Recognize
  // only the exact label directly before an OCR anchor, never arbitrary prose.
  const labels = [...text.matchAll(/^\[图片文字识别\]\n/gm)].map(match => ({
    start: match.index!, end: match.index! + match[0].length,
  })).filter(label => anchors.some(a => a.kind === 'ocr' && a.start === location.start + label.end));
  const unmappedText = (from: number, to: number) => {
    let cursor = from;
    for (const label of labels.filter(label => label.start >= from && label.end <= to)) {
      if (/\S/.test(text.slice(cursor, label.start))) return true;
      cursor = label.end;
    }
    return /\S/.test(text.slice(cursor, to));
  };
  // Do not claim precise text highlighting when the geometry itself is incomplete.
  let covered = 0;
  for (const anchor of anchors) {
    const start = Math.max(0, anchor.start - location.start);
    if (start > covered && unmappedText(covered, start)) return [source];
    covered = Math.max(covered, anchor.end - location.start);
  }
  if (unmappedText(covered, text.length)) return [source];

  const cuts = new Set<number>();
  for (const match of text.matchAll(/\n[ \t]*\n+/g)) cuts.add(match.index! + match[0].length);
  for (let i = 1; i < anchors.length; i++) {
    const previous = anchors[i - 1], next = anchors[i];
    const left = previous.rects[0], right = next.rects[0];
    const height = Math.max(left[3] - left[1], right[3] - right[1]);
    const separateColumns = Math.min(left[3], right[3]) - Math.max(left[1], right[1]) > height * 0.3 &&
      Math.max(right[0] - left[2], left[0] - right[2]) > Math.max(0.08, height * 3);
    if (next.page !== previous.page || (height > 0 && previous.rects.length === 1 && next.rects.length === 1 &&
      (right[1] - left[3] > height * 2 || right[3] < left[1] - height / 2 || separateColumns)))
      cuts.add(labels.find(label => label.end === next.start - location.start)?.start ?? next.start - location.start);
  }
  const boundaries = [...cuts].filter(cut => cut > 0 && cut < text.length && /\S/.test(text.slice(cut)) && !anchors.some(anchor =>
    anchor.start < location.start + cut && anchor.end > location.start + cut &&
    /\S/.test(text.slice(Math.max(0, anchor.start - location.start), cut)) &&
    /\S/.test(text.slice(cut, anchor.end - location.start)),
  )).sort((a, b) => a - b);
  if (!boundaries.length) return [source];
  const result: T[] = [];
  let start = 0;
  for (const end of [...boundaries, text.length]) {
    if (!/\S/.test(text.slice(start, end)) && end !== text.length) continue;
    // Keep separators in the preceding slice so full-document coverage stays exact.
    const sliced = sliceSourceLocation(location, location.start + start, location.start + end);
    result.push({ ...source, text: text.slice(start, end),
      location: { ...sliced, page: sliced.anchors?.[0]?.page ?? location.page } });
    start = end;
  }
  return result;
}
