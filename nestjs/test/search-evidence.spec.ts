import { compactSearchEvidence } from '../src/modules/agent/search-evidence';
import type { OriginalEvidence } from '../src/modules/rag/retrieval.types';

const first: OriginalEvidence = {
  evidenceId: 'a', number: 1, documentId: 2, knowledgeBaseId: 3, versionId: 4,
  indexRevisionId: 5, chunkId: 6, filename: '资料.pdf', text: '字段顺序：目的地址',
  location: { page: 1, paragraph: 1, heading: null, start: 10, end: 19, contentType: 'native' },
  score: 1,
};
const second: OriginalEvidence = {
  ...first, evidenceId: 'b', chunkId: 7, text: '目的地址、源地址',
  location: { ...first.location!, start: 15, end: 23 },
};
const original = (source: Omit<OriginalEvidence, 'evidenceId'>) => ({ ...source, evidenceId: 'merged' });

it('unites exact overlapping text and retains accurate offsets and child chunks', () => {
  const [merged, ...rest] = compactSearchEvidence([first, second], original);
  expect(rest).toEqual([]);
  expect(merged).toMatchObject({
    text: '字段顺序：目的地址、源地址',
    chunkIds: [6, 7],
    location: { start: 10, end: 23, page: 1 },
  });
});

it('preserves different pages and visually derived evidence', () => {
  const otherPage = { ...second, location: { ...second.location!, page: 2 } };
  const figure = { ...second, location: { ...second.location!, contentType: 'figure' as const } };
  expect(compactSearchEvidence([first, otherPage, figure], original)).toEqual([first, otherPage, figure]);
});
