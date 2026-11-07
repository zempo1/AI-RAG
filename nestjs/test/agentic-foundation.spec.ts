import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { MemoryStore } from '../src/persistence/memory.store';
import { KnowledgeBasesService } from '../src/modules/knowledge-bases/knowledge-bases.service';

async function fixture() {
  const module = await import('../src/modules/rag/' + 'retrieval.service').catch(() => ({} as any));
  expect(module.RetrievalService).toBeDefined();
  const store = new MemoryStore();
  const kb = await store.save('knowledgeBases', { userId: 1, name: 'kb' });
  const revision = await store.save('indexRevisions', {});
  const doc = await store.save('documents', { userId: 1, knowledgeBaseId: kb.id, filename: 'a.pdf', activeIndexRevisionId: revision.id });
  const base = { documentId: doc.id, indexRevisionId: revision.id, versionId: 1 };
  const native = await store.save('chunks', { ...base, chunkIndex: 0, text: 'TS-999 清理缓存。', location: { page: 1, start: 0, end: 13, contentType: 'native' } });
  const visual = await store.save('chunks', { ...base, chunkIndex: 1, text: '图解 TS-999', location: { page: 1, start: 30, end: 40, regionImage: 'figure', contentType: 'figure' }, retrievalMetadata: { parentId: 'p', parentText: '图解 TS-999', parentLocation: { page: 1, start: 30, end: 40, regionImage: 'figure', contentType: 'figure' }, contextRanges: [{ start: 0, end: 6 }] } });
  const embeddings = { embedQuery: jest.fn(async () => [1]) };
  const vectors = { search: jest.fn(async () => []) };
  const service = new module.RetrievalService(embeddings, vectors, store, new KnowledgeBasesService(store), undefined, undefined, new ConfigService({ STORAGE_DRIVER: 'memory' }));
  return { service, store, kb, doc, native, visual, embeddings };
}

it('keyword search never calls Embedding and returns only the frozen scope', async () => {
  const f = await fixture();
  const scope = await f.service.createScope(1, f.kb.id);
  const session = await f.service.open(scope);
  const result = await f.service.search(session, 'TS-999', { strategy: 'keyword' });
  expect(result.candidates.length).toBeGreaterThan(0);
  expect(f.embeddings.embedQuery).not.toHaveBeenCalled();
  expect(result.evidence.every((e: any) => e.documentId === f.doc.id && typeof e.evidenceId === 'string')).toBe(true);
});

it('expands parent evidence and visual context as exact independent original ranges', async () => {
  const f = await fixture();
  const session = await f.service.open(await f.service.createScope(1, f.kb.id));
  const evidence = f.service.expand(session, [{ id: f.visual.id, score: 1 }]);
  expect(evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: '图解 TS-999', chunkIds: [f.visual.id] }),
    expect.objectContaining({ text: f.native.text.slice(0, 6), location: expect.objectContaining({ start: 0, end: 6 }) }),
  ]));
  expect(evidence[0].evidenceId).toBe(f.service.expand(session, [{ id: f.visual.id, score: 0.2 }])[0].evidenceId);
});

it('rejects foreign scope, changed revisions and narrowed scope escape', async () => {
  const f = await fixture();
  await expect(f.service.createScope(2, f.kb.id)).rejects.toMatchObject({ status: 404 });
  const scope = await f.service.createScope(1, f.kb.id);
  await expect(f.service.open(scope, [999])).rejects.toMatchObject({ status: 404 });
  await f.store.save('documents', { id: f.doc.id, activeIndexRevisionId: 999 });
  await expect(f.service.verify(scope)).rejects.toMatchObject({ status: 409 });
});

it('reads only requested document ranges and reports cursor coverage without truncating original evidence', async () => {
  const f = await fixture();
  const session = await f.service.open(await f.service.createScope(1, f.kb.id));
  const page = await f.service.read(session, { documentId: f.doc.id, pageStart: 1, pageEnd: 1, limit: 1 });
  expect(page.evidence).toHaveLength(1);
  expect(page.complete).toBe(false);
  expect(page.nextCursor).toBe(1);
  const tail = await f.service.read(session, { documentId: f.doc.id, cursor: page.nextCursor });
  expect(tail.complete).toBe(true);
  expect(tail.evidence[0].chunkId).toBe(f.visual.id);
  await expect(f.service.read(session, { documentId: 999 })).rejects.toMatchObject({ status: 404 });
});

it('packs evidence to a token budget while preserving original stable IDs', async () => {
  const f = await fixture();
  const session = await f.service.open(await f.service.createScope(1, f.kb.id));
  const evidence = f.service.expand(session, [{ id: f.native.id, score: 1 }], false);
  const packed = await f.service.pack(evidence, 1);
  expect(packed.sources).toEqual([]);
  expect(packed.complete).toBe(false);
});
