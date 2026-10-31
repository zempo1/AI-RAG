import { createHash } from 'node:crypto';
import { Segment } from './vector-store.interface';

export function pointId(segment: Segment): string {
  const hash = createHash('sha256')
    .update(
      [
        segment.userId,
        segment.knowledgeBaseId ?? 0,
        segment.documentId,
        segment.indexRevisionId ?? 0,
        segment.chunkIndex,
      ].join('/'),
    )
    .digest('hex');
  return (
    hash.slice(0, 8) +
    '-' +
    hash.slice(8, 12) +
    '-5' +
    hash.slice(13, 16) +
    '-a' +
    hash.slice(17, 20) +
    '-' +
    hash.slice(20, 32)
  );
}
