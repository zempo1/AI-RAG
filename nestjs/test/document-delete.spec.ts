import { pipeline } from './helpers/pipeline';

it('deletes only associated results and vectors, preserving same-name and legacy maps', async () => {
  const p = await pipeline();
  try {
    const doc = await p.documents.ingest(Buffer.from('正文'), 'same.md', 1);
    const other = await p.documents.ingest(Buffer.from('其他正文'), 'same.md', 2);
    await p.indexing.process(doc.taskId);
    await p.indexing.process(other.taskId);
    for (const type of ['SUMMARY', 'OUTLINE', 'FLASHCARD'])
      await p.store.save('analyses', { documentId: doc.documentId, userId: 1, type });
    await p.store.save('mindmaps', { documentId: doc.documentId, userId: 1 });
    await p.store.save('mindmaps', { documentId: other.documentId, userId: 2 });
    await p.store.save('mindmaps', { userId: 1, title: 'same.md - Mind Map' });
    await expect(p.documents.delete(doc.documentId, 2)).rejects.toMatchObject({ status: 404 });
    const deletion = await p.documents.delete(doc.documentId, 1);
    await expect(p.documents.owned(doc.documentId, 1)).rejects.toMatchObject({ status: 404 });
    await p.indexing.process(deletion.taskId);
    expect(await p.store.list('analyses')).toHaveLength(0);
    expect(await p.store.list('mindmaps')).toHaveLength(2);
    expect(p.vectors.search([1, 0], 10, 0).map((m) => m.segment.documentId)).toEqual([
      other.documentId,
    ]);
  } finally {
    await p.cleanup();
  }
});
