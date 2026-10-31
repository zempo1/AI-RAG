import { pipeline } from './helpers/pipeline';

describe('asynchronous document lifecycle', () => {
  let p: Awaited<ReturnType<typeof pipeline>>;
  beforeEach(async () => {
    p = await pipeline();
  });
  afterEach(async () => {
    await p.cleanup();
  });
  const upload = async (text = '旧版正文') => p.documents.ingest(Buffer.from(text), 'a.md', 1);

  it('accepts without embedding, publishes once and persists progress and original bytes', async () => {
    p.setFailure(true);
    const accepted = await upload();
    expect((await p.tasks.get(accepted.taskId, 1)).status).toBe('queued');
    expect((await p.documents.owned(accepted.documentId, 1)).activeIndexRevisionId).toBeNull();
    p.setFailure(false);
    await p.indexing.process(accepted.taskId);
    await p.indexing.process(accepted.taskId);
    const doc = await p.documents.owned(accepted.documentId, 1);
    expect(doc.status).toBe('ready');
    expect((await p.tasks.get(accepted.taskId, 1)).status).toBe('completed');
    expect(
      (
        await p.vectors.search([1, 0], 5, 0, {
          userId: 1,
          knowledgeBaseId: doc.knowledgeBaseId,
          indexRevisionIds: [doc.activeIndexRevisionId],
        })
      ).map((m) => m.segment.text),
    ).toEqual(['旧版正文']);
  });

  it('preserves the published version after a failed replacement and only publishes the latest accepted replacement', async () => {
    const first = await upload();
    await p.indexing.process(first.taskId);
    const original = await p.documents.owned(first.documentId, 1);
    const second = await p.documents.ingest(Buffer.from('第二版'), 'a.md', 1, {
      documentId: first.documentId,
    });
    const third = await p.documents.ingest(Buffer.from('第三版'), 'a.md', 1, {
      documentId: first.documentId,
    });
    await p.indexing.process(second.taskId);
    expect((await p.documents.owned(first.documentId, 1)).activeIndexRevisionId).toBe(
      original.activeIndexRevisionId,
    );
    p.setFailure(true);
    await expect(p.indexing.process(third.taskId, 3)).rejects.toThrow('embedding unavailable');
    expect((await p.documents.owned(first.documentId, 1)).content).toBe('旧版正文');
    p.setFailure(false);
    await p.tasks.retry(third.taskId, 1);
    await p.indexing.process(third.taskId);
    expect((await p.documents.owned(first.documentId, 1)).content).toBe('第三版');
  });

  it('deduplicates a repeated submission by persistent scope and key', async () => {
    const kb = await p.libraries.default(1);
    const a = await p.documents.ingest(Buffer.from('内容'), 'a.md', 1, {
      knowledgeBaseId: kb.id,
      idempotencyKey: 'same-upload',
    });
    const b = await p.documents.ingest(Buffer.from('内容'), 'a.md', 1, {
      knowledgeBaseId: kb.id,
      idempotencyKey: 'same-upload',
    });
    expect(b).toEqual(a);
    const other = await p.libraries.create(1, '另一个库');
    const c = await p.documents.ingest(Buffer.from('内容'), 'a.md', 1, {
      knowledgeBaseId: other.id,
      idempotencyKey: 'same-upload',
    });
    expect(c.documentId).not.toBe(a.documentId);
  });

  it('does not let a stale execution cancel or clean a revision already published by a redelivered job', async () => {
    const first = await upload();
    let release!: () => void,
      entered!: () => void,
      calls = 0;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    p.beforeEmbedding(async () => {
      if (++calls === 1) {
        entered();
        await gate;
      }
    });
    const stale = p.indexing.process(first.taskId);
    await started;
    await p.indexing.process(first.taskId);
    release();
    await stale;
    expect((await p.tasks.get(first.taskId, 1)).status).toBe('completed');
    const doc = await p.documents.owned(first.documentId, 1);
    expect(
      p.vectors.search([1, 0], 5, 0, {
        userId: 1,
        knowledgeBaseId: doc.knowledgeBaseId,
        indexRevisionIds: [doc.activeIndexRevisionId],
      }),
    ).toHaveLength(1);
  });

  it('prevents an in-flight embedding from resurrecting a deleted document', async () => {
    const first = await upload();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    p.beforeEmbedding(async () => {
      entered();
      await gate;
    });
    const run = p.indexing.process(first.taskId);
    await started;
    const deletion = await p.documents.delete(first.documentId, 1);
    await expect(p.documents.owned(first.documentId, 1)).rejects.toMatchObject({ status: 404 });
    release();
    await run;
    await p.indexing.process(deletion.taskId);
    expect(await p.vectors.search([1, 0], 100, 0)).toEqual([]);
    expect((await p.tasks.get(first.taskId, 1)).status).toBe('canceled');
  });

  it('locks writes during library rebuild and releases the lock after partial failure', async () => {
    const first = await upload();
    await p.indexing.process(first.taskId);
    const second = await upload('另一文件');
    await p.indexing.process(second.taskId);
    const doc = await p.documents.owned(first.documentId, 1);
    const parent = await p.documents.reindexLibrary(doc.knowledgeBaseId, 1);
    await expect(upload()).rejects.toMatchObject({ status: 409 });
    const children = await p.store.list('tasks', { parentTaskId: parent.taskId });
    await p.indexing.process(children[0].id);
    p.setFailure(true);
    await expect(p.indexing.process(children[1].id, 3)).rejects.toThrow();
    expect((await p.tasks.get(parent.taskId, 1)).status).toBe('partial_failed');
    expect((await p.libraries.owned(doc.knowledgeBaseId, 1)).rebuildTaskId).toBeNull();
    expect((await p.documents.owned(second.documentId, 1)).activeIndexRevisionId).not.toBeNull();
  });
});
