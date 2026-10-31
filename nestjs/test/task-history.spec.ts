import { pipeline } from './helpers/pipeline';

it('dismisses only settled owned tasks without deleting internal task references', async () => {
  const p = await pipeline();
  try {
    const accepted = await p.documents.ingest(Buffer.from('资料'), 'a.md', 1);
    await expect(p.tasks.dismiss(accepted.taskId, 2)).rejects.toMatchObject({ status: 404 });
    await expect(p.tasks.dismiss(accepted.taskId, 1)).rejects.toThrow('进行中');
    await p.indexing.process(accepted.taskId);
    await p.tasks.dismiss(accepted.taskId, 1);
    expect(await p.tasks.list(1, accepted.knowledgeBaseId)).toHaveLength(0);
    expect(await p.store.get('tasks', accepted.taskId)).toBeTruthy();
    expect(
      (await p.store.get('documents', accepted.documentId))?.activeIndexRevisionId,
    ).toBeTruthy();
  } finally {
    await p.cleanup();
  }
});

it('clears successful history while retaining failures and reports delayed cleanup', async () => {
  const p = await pipeline();
  try {
    const a = await p.documents.ingest(Buffer.from('正文'), 'b.md', 1);
    await p.indexing.process(a.taskId);
    const failed = await p.tasks.create(p.store, {
      userId: 1,
      knowledgeBaseId: a.knowledgeBaseId,
      kind: 'index',
      status: 'failed',
      stage: 'failed',
    });
    const delayed = await p.tasks.create(p.store, {
      userId: 1,
      knowledgeBaseId: a.knowledgeBaseId,
      kind: 'cleanup',
      payload: { notBefore: new Date(Date.now() + 600000).toISOString().slice(0, 23) },
    });
    await p.tasks.clearCompleted(1, a.knowledgeBaseId);
    const rows = await p.tasks.list(1, a.knowledgeBaseId);
    expect(rows.map((t) => t.id)).toEqual(expect.arrayContaining([failed.id, delayed.id]));
    expect(rows.find((t) => t.id === delayed.id)?.waitingReason).toContain('保留期');
    await p.store.save('tasks', { id: failed.id, executionToken: 'still-running' });
    await expect(p.tasks.dismiss(failed.id, 1)).rejects.toThrow('进行中');
  } finally {
    await p.cleanup();
  }
});
