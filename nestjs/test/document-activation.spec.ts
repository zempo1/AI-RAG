import { pipeline } from './helpers/pipeline';

describe('asynchronous activation reuse', () => {
  it('reuses a published revision and validates ownership', async () => {
    const p = await pipeline();
    try {
      const doc = await p.documents.ingest(Buffer.from('内容'), 'a.md', 1);
      await p.indexing.process(doc.taskId);
      await p.documents.activate(doc.documentId, 1);
      await p.documents.activate(doc.documentId, 1);
      expect(await p.store.list('tasks')).toHaveLength(1);
      expect(p.vectors.search([1, 0], 10, 0)).toHaveLength(1);
      await expect(p.documents.activate(doc.documentId, 2)).rejects.toMatchObject({ status: 404 });
    } finally {
      await p.cleanup();
    }
  });
  it('coalesces concurrent legacy activations into one task and preserves unknown page numbers', async () => {
    const p = await pipeline();
    try {
      const legacy = await p.store.save('documents', {
        userId: 1,
        filename: 'old.pdf',
        content: '历史内容',
        deletedAt: null,
      });
      const results = await Promise.all([
        p.documents.activate(legacy.id, 1),
        p.documents.activate(legacy.id, 1),
      ]);
      expect(results[0].taskId).toBe(results[1].taskId);
      await p.indexing.process(results[0].taskId);
      expect((await p.store.list('chunks'))[0].location.page).toBeNull();
    } finally {
      await p.cleanup();
    }
  });
});
