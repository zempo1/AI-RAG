import type { Citation } from '../rag/citations';
import { mergeSourceLocations } from '../documents/parsers/source-anchors';
import type { OriginalEvidence } from '../rag/retrieval.types';

/** Compact matching contiguous text only; visual references keep their own source regions. */
export function compactSearchEvidence(
  evidence: OriginalEvidence[],
  original: (source: Citation) => OriginalEvidence,
) {
  const result: OriginalEvidence[] = [];
  for (const item of evidence) {
    let merged = item;
    let insertAt = result.length;
    for (let i = 0; i < result.length; i++) {
      const combined = mergeOverlap(result[i], merged, original);
      if (!combined) continue;
      merged = combined;
      insertAt = Math.min(insertAt, i);
      result.splice(i, 1);
      i = -1;
    }
    result.splice(insertAt, 0, merged);
  }
  return result;
}

function mergeOverlap(
  a: OriginalEvidence,
  b: OriginalEvidence,
  original: (source: Citation) => OriginalEvidence,
) {
  const x = a.location, y = b.location;
  if (!x || !y || a.documentId !== b.documentId || a.versionId !== b.versionId ||
      a.indexRevisionId !== b.indexRevisionId || x.page !== y.page ||
      x.pageImage || y.pageImage || x.regionImage || y.regionImage ||
      (x.contentType && x.contentType !== 'native') || (y.contentType && y.contentType !== 'native') ||
      a.text.length !== x.end - x.start || b.text.length !== y.end - y.start) return;
  const start = Math.max(x.start, y.start), end = Math.min(x.end, y.end);
  if (start >= end || a.text.slice(start - x.start, end - x.start) !==
      b.text.slice(start - y.start, end - y.start)) return;
  if (x.start <= y.start && x.end >= y.end) return a;
  if (y.start <= x.start && y.end >= x.end) return b;
  if (x.paragraph !== y.paragraph || x.heading !== y.heading) return;
  const [left, right] = x.start < y.start ? [a, b] : [b, a];
  const text = left.text + right.text.slice(end - start);
  if (Buffer.byteLength(text, 'utf8') > 4000) return;
  return original({
    ...left,
    text,
    score: Math.max(a.score, b.score),
    chunkIds: [...new Set([...(a.chunkIds ?? [a.chunkId]), ...(b.chunkIds ?? [b.chunkId])])],
    location: mergeSourceLocations(left.location!, right.location!),
  });
}
