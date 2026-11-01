import { pipeline } from './helpers/pipeline';
import { RagService } from '../src/modules/rag/rag.service';
import { normalizeCitations } from '../src/modules/rag/citations';
import { HistoryService } from '../src/modules/history/history.service';

describe('scoped retrieval and citation snapshots', () => {
  let p: Awaited<ReturnType<typeof pipeline>>;
  beforeEach(async () => {
    p = await pipeline();
  });
  afterEach(async () => {
    await p.cleanup();
  });
  it('retains a deleted revision long enough for a request that already selected its snapshot', async () => {
    p.config.set('INDEX_RETENTION_MS', 600000);
    const uploaded = await p.documents.ingest(Buffer.from('删除前的原文'), 'a.md', 1);
    await p.indexing.process(uploaded.taskId);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rag = new RagService(
      {
        embedQuery: async () => {
          entered();
          await gate;
          return [1, 0];
        },
      } as any,
      p.vectors,
      p.store,
      p.libraries,
    );
    const snapshot = rag.prepare('内容', 1, uploaded.knowledgeBaseId);
    await started;
    const deletion = await p.documents.delete(uploaded.documentId, 1);
    expect(await p.indexing.process(deletion.taskId)).toBe('waiting');
    release();
    expect((await snapshot).sources[0].text).toBe('删除前的原文');
    expect(
      (
        await new RagService(p.embeddings as any, p.vectors, p.store, p.libraries).prepare(
          '内容',
          1,
          uploaded.knowledgeBaseId,
        )
      ).sources,
    ).toEqual([]);
  });

  it('retrieves only the selected library and uses current file metadata with immutable source text', async () => {
    const a = await p.libraries.create(1, 'A');
    const b = await p.libraries.create(1, 'B');
    const da = await p.documents.ingest(Buffer.from('A 库原文'), 'a.md', 1, {
      knowledgeBaseId: a.id,
    });
    const db = await p.documents.ingest(Buffer.from('B 库原文'), 'b.md', 1, {
      knowledgeBaseId: b.id,
    });
    await p.indexing.process(da.taskId);
    await p.indexing.process(db.taskId);
    await p.documents.update(da.documentId, 1, { filename: '重命名.md' });
    const rag = new RagService(p.embeddings as any, p.vectors, p.store, p.libraries);
    const result = await rag.prepare('内容', 1, a.id);
    expect(result.sources.map((s) => [s.filename, s.text])).toEqual([['重命名.md', 'A 库原文']]);
    await expect(rag.prepare('内容', 2, a.id)).rejects.toMatchObject({ status: 404 });
    const empty = await p.libraries.create(1, '空库');
    expect((await rag.prepare('内容', 1, empty.id)).sources).toEqual([]);
  });

  it('removes invented source numbers and persists only references actually used by the answer', async () => {
    const accepted = await p.documents.ingest(
      Buffer.from('# 第一节\n\n第一段\n\n# 第二节\n\n第二段'),
      'a.md',
      1,
    );
    await p.indexing.process(accepted.taskId);
    const rag = new RagService(p.embeddings as any, p.vectors, p.store, p.libraries);
    const context = await rag.prepare('内容', 1, accepted.knowledgeBaseId);
    const final = normalizeCitations('结论[2]。不存在[99]，再次引用[2]。', context.sources);
    expect(final.answer).toBe('结论[2]。不存在，再次引用[2]。');
    expect(final.citations.map((c) => c.text)).toEqual(['# 第二节\n\n第二段']);
    const history = new HistoryService(p.store, p.libraries);
    const chat = await history.create('问答', 1, accepted.knowledgeBaseId);
    await history.addMessage(chat.id, 1, 'assistant', final.answer, final.citations, 'completed');
    await p.documents.delete(accepted.documentId, 1);
    const loaded = await history.get(chat.id, 1);
    expect(loaded.messages[0].citations[0]).toMatchObject({
      text: '# 第二节\n\n第二段',
      sourceDeleted: true,
    });
    await p.documents.deleteLibrary(accepted.knowledgeBaseId, 1);
    expect((await history.get(chat.id, 1)).readOnly).toBe(true);
    await expect(history.writable(chat.id, 1, accepted.knowledgeBaseId)).rejects.toMatchObject({
      status: 409,
    });
  });
});
