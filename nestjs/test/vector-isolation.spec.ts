import { InMemoryVectorStore } from '../src/modules/vector-store/in-memory-vector-store.service';

it('filters user, library and published revision before topK and upserts stable point ids', async () => {
  const store = new InMemoryVectorStore();
  const base = {
    userId: 1,
    knowledgeBaseId: 1,
    documentId: 1,
    versionId: 1,
    indexRevisionId: 1,
    chunkIndex: 0,
    chunkId: 1,
    filename: 'a.md',
    text: '正确内容',
  };
  await store.addAll([[0.8, 0.2]], [base]);
  await store.addAll([[0.8, 0.2]], [base]);
  for (let i = 0; i < 20; i++)
    await store.addAll(
      [[1, 0]],
      [{ ...base, documentId: 10 + i, chunkId: 10 + i, indexRevisionId: 2, text: '错误版本' }],
    );
  await store.addAll([[1, 0]], [{ ...base, userId: 2, text: '其他用户' }]);
  await store.addAll([[1, 0]], [{ ...base, knowledgeBaseId: 2, text: '其他知识库' }]);
  const result = await store.search([1, 0], 5, 0, {
    userId: 1,
    knowledgeBaseId: 1,
    indexRevisionIds: [1],
  });
  expect(result.map((r) => r.segment.text)).toEqual(['正确内容']);
  await store.removeRevision(1, 1);
  expect(
    await store.search([1, 0], 5, 0, { userId: 1, knowledgeBaseId: 1, indexRevisionIds: [1] }),
  ).toEqual([]);
});
