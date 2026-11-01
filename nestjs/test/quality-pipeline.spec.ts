import { jest } from '@jest/globals';
import { pipeline } from './helpers/pipeline';
import { RagService } from '../src/modules/rag/rag.service';
import { SummaryService } from '../src/modules/rag/summary.service';
import { RetrievalRunsController } from '../src/modules/rag/retrieval-runs.controller';
import { ApiError } from '../src/common/api-error';

const tokenizer = { count: async (text: string) => Array.from(text).length };
const configuration = (extra: Record<string, any> = {}) => ({
  get: (key: string) =>
    ({ STORAGE_DRIVER: 'mysql', CHAT_MODEL: 'test', CHAT_TOKENIZER: 'test', ...extra })[key],
});

it('preserves an explicit full-document intent when remote planning is unavailable', async () => {
  const p = await pipeline();
  try {
    const a = await p.documents.ingest(Buffer.from('章节正文。'.repeat(180)), 'overview.md', 1);
    await p.indexing.process(a.taskId);
    const rag = new RagService(
      p.embeddings as any,
      p.vectors,
      p.store,
      p.libraries,
      tokenizer as any,
      {
        plan: async () => {
          throw new Error('upstream unavailable');
        },
      } as any,
      configuration({ RAG_EVIDENCE_TOKENS: 100 }) as any,
    );
    const result = await rag.prepare('请总结全文', 1, a.knowledgeBaseId, {
      documentIds: [a.documentId],
    });
    expect(result.diagnostics.mode).toBe('overview');
    expect(result.requiresAsync).toBe(true);
    expect(result.diagnostics.degraded).toContain('query_planning_failed_original_question');
  } finally {
    await p.cleanup();
  }
});

it('reuses the winning summary cache when two workers race on the unique cache key', async () => {
  const p = await pipeline();
  try {
    const original = p.store.save.bind(p.store);
    let writing: Promise<any> | undefined;
    jest.spyOn(p.store, 'save').mockImplementation(async (table, row) => {
      if (table !== 'summaryCaches') return original(table, row);
      if (writing) {
        await writing;
        throw new ApiError(409, '记录重复');
      }
      writing = original(table, row);
      return writing;
    });
    const llm = {
      complete: async (prompt: string) =>
        prompt.startsWith('核查') ? '{"supported":true}' : '清理缓存。[1]',
    };
    const service = new SummaryService(
      p.store,
      llm as any,
      tokenizer as any,
      configuration() as any,
    );
    const snapshot: any = {
      userId: 1,
      knowledgeBaseId: 1,
      question: '总结',
      mode: 'overview',
      revisions: [1],
      history: [],
      diagnostics: {},
      sources: [
        {
          number: 1,
          documentId: 1,
          knowledgeBaseId: 1,
          versionId: 1,
          indexRevisionId: 1,
          chunkId: 1,
          filename: 'a.md',
          text: '清理缓存。',
          location: null,
          score: 0,
        },
      ],
    };
    const results = await Promise.all([service.summarize(snapshot), service.summarize(snapshot)]);
    expect(results.every((r) => r.coverage.complete)).toBe(true);
    expect(await p.store.list('summaryCaches')).toHaveLength(1);
  } finally {
    await p.cleanup();
  }
});
const models = {
  plan: async (q: string) => ({
    query: q,
    keywords: [],
    mode: 'search',
    documentIds: [],
    ambiguous: false,
  }),
  rerank: async (_q: string, texts: string[]) =>
    texts.map((_t, i) => ({ index: i, score: 0.9 - i * 0.01 })),
};

it('scopes both retrieval channels and expands parent metadata, including exact identifiers', async () => {
  const p = await pipeline();
  try {
    const a = await p.documents.ingest(
      Buffer.from('# 参数\n\nTS-999 应清理缓存。'),
      'manual.md',
      1,
    );
    await p.indexing.process(a.taskId);
    const other = await p.libraries.create(1, '其他库');
    const b = await p.documents.ingest(Buffer.from('TS-999 错误答案'), 'other.md', 1, {
      knowledgeBaseId: other.id,
    });
    await p.indexing.process(b.taskId);
    const rag = new RagService(
      p.embeddings as any,
      p.vectors,
      p.store,
      p.libraries,
      tokenizer as any,
      models as any,
      configuration() as any,
    );
    const result = await rag.prepare('TS-999 如何解决', 1, a.knowledgeBaseId);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.every((s) => s.documentId === a.documentId)).toBe(true);
    expect(result.diagnostics.candidates.lexical.length).toBeGreaterThan(0);
    const controller = new RetrievalRunsController(
      p.store,
      configuration({ DB_TIMEZONE: '+08:00' }) as any,
    );
    await expect(controller.get(2, result.diagnostics.runId)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await controller.get(1, result.diagnostics.runId)).finalEvidence.length,
    ).toBeGreaterThan(0);
  } finally {
    await p.cleanup();
  }
});

it('degrades on one retrieval failure, rejects unknown document IDs, and budgets long overviews', async () => {
  const p = await pipeline();
  try {
    const a = await p.documents.ingest(
      Buffer.from('TS-999 清理缓存。'.repeat(100)),
      'manual.md',
      1,
    );
    await p.indexing.process(a.taskId);
    jest.spyOn(p.embeddings, 'embedQuery').mockRejectedValue(new Error('API timeout'));
    const rag = new RagService(
      p.embeddings as any,
      p.vectors,
      p.store,
      p.libraries,
      tokenizer as any,
      {
        ...models,
        rerank: async () => {
          throw new Error('429');
        },
      } as any,
      configuration({ RAG_EVIDENCE_TOKENS: 100 }) as any,
    );
    const detail = await rag.prepare('TS-999', 1, a.knowledgeBaseId);
    expect(detail.diagnostics.degraded).toEqual(
      expect.arrayContaining(['vector_failed', 'rerank_failed_rrf_fallback']),
    );
    await expect(
      rag.prepare('问题', 1, a.knowledgeBaseId, { documentIds: [999] }),
    ).rejects.toMatchObject({ status: 404 });
    const overview = await rag.prepare('总结全文', 1, a.knowledgeBaseId, {
      mode: 'overview',
      documentIds: [a.documentId],
    });
    expect(overview.requiresAsync).toBe(true);
    expect(overview.snapshot?.sources.length).toBeGreaterThan(0);
    expect(
      overview.diagnostics.tokens.input + overview.diagnostics.tokens.reserved,
    ).toBeLessThanOrEqual(overview.diagnostics.tokens.window);
  } finally {
    await p.cleanup();
  }
});

it('caches version-bound summaries and verifies final paragraphs against original sources', async () => {
  const p = await pipeline();
  try {
    const llm = {
      complete: jest.fn(async (prompt: string) =>
        prompt.startsWith('核查') ? ' {"supported":true} ' : '文档要求清理缓存。[1]',
      ),
    };
    const service = new SummaryService(
      p.store,
      llm as any,
      tokenizer as any,
      configuration() as any,
    );
    const snapshot: any = {
      userId: 1,
      knowledgeBaseId: 1,
      question: '概览',
      mode: 'overview',
      revisions: [1],
      history: [],
      diagnostics: {},
      sources: [
        {
          number: 1,
          documentId: 1,
          knowledgeBaseId: 1,
          versionId: 1,
          indexRevisionId: 1,
          chunkId: 1,
          filename: 'a.md',
          text: '文档要求清理缓存。',
          location: { heading: '参数', page: 1 },
          score: 0,
        },
      ],
    };
    const first = await service.summarize(snapshot);
    expect(first.coverage.complete).toBe(true);
    expect(first.citations[0].chunkId).toBe(1);
    await service.summarize(snapshot);
    expect(llm.complete).toHaveBeenCalledTimes(3);
    snapshot.revisions = [2];
    snapshot.sources[0].indexRevisionId = 2;
    await service.summarize(snapshot);
    expect(llm.complete).toHaveBeenCalledTimes(5);
  } finally {
    await p.cleanup();
  }
});
