import { RetrievalService } from '../src/modules/rag/retrieval.service';
import { normalizeCitations } from '../src/modules/rag/citations';
import type { OriginalEvidence } from '../src/modules/rag/retrieval.types';
import { ConfigService } from '@nestjs/config';
import { MemoryStore } from '../src/persistence/memory.store';
import { KnowledgeBasesService } from '../src/modules/knowledge-bases/knowledge-bases.service';
import { SummaryService } from '../src/modules/rag/summary.service';
import { AgentTools } from '../src/modules/agent/agent-tools';
import { verifiedSummaryResult } from '../src/modules/agent/agent-summary-result';
import { HistoryService } from '../src/modules/history/history.service';

const retrieval = new RetrievalService({} as any, {} as any, {} as any, {} as any);
const bdp = '针对医院科室业务差异，基于 BDP 实现按钮级可见性及业务分支声明式管控';
const performance = '设计骨架屏预渲染页面结构，将首屏加载时长缩短约40%';
function evidence(parts: string[], separator = '\n\n'): OriginalEvidence {
  const text = parts.join(separator);
  let offset = 100;
  const anchors = parts.map((part, i) => {
    const anchor = { page: 1, start: offset, end: offset + part.length, kind: 'native' as const,
      rects: [[0.1, 0.2 + i * 0.2, 0.9, 0.22 + i * 0.2] as [number, number, number, number]] };
    offset = anchor.end + separator.length;
    return anchor;
  });
  return retrieval.original({ number: 0, documentId: 1, knowledgeBaseId: 1, versionId: 2,
    indexRevisionId: 3, chunkId: 4, filename: 'resume.pdf', text, score: 1,
    location: { start: 100, end: 100 + text.length, page: 1, paragraph: 1, heading: null,
      anchorVersion: 1, anchors } });
}

it('gives unrelated PDF paragraphs separate citation numbers and exact independent highlights', async () => {
  const source = evidence([bdp, performance, '动态生成分享海报']);
  const before = structuredClone(source);
  const packed = await retrieval.pack([source], 10000, { readingOrder: true });
  const hit = packed.sources.find(s => s.text.includes('骨架屏'))!;
  const saved = normalizeCitations(`首屏加载优化：缩短约40%[${hit.number}]`, packed.sources).citations[0];
  expect(saved.text.trim()).toBe(performance);
  expect(saved.location!.anchors).toHaveLength(1);
  expect(saved.location!.anchors![0].rects).toEqual([[0.1, 0.4, 0.9, 0.42000000000000004]]);
  expect(saved.text).toBe(source.text.slice(saved.location!.start - 100, saved.location!.end - 100));
  expect(hit.evidenceId).not.toBe(source.evidenceId);
  expect(packed.complete).toBe(true);
  expect(packed.sources.map(s => s.text).join('')).toBe(source.text);
  expect(source).toEqual(before);
  const prompt = retrieval.context(packed.sources, { readingOrder: true });
  expect(prompt).toContain(`${performance}[${hit.number}]`);
});

it('also separates physically distant text stored with only a soft line break', async () => {
  const source = evidence([bdp, performance], '\n');
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources.find(s => s.text.includes('骨架屏'))!.text.trim()).toBe(performance);
});

it('keeps consecutive wrapped lines together instead of splitting every PDF text item', async () => {
  const source = evidence(['设计骨架屏预渲染页面结构', '首屏加载时长缩短约40%'], '\n');
  source.location!.anchors![1].rects = [[0.1, 0.225, 0.8, 0.245]];
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources).toHaveLength(1);
  expect(packed.sources[0].text).toBe(source.text);
  expect(packed.sources[0].location!.anchors).toHaveLength(2);
});

it('does not invent precise subranges for a model description backed by one region', async () => {
  const source = evidence([bdp, performance]);
  source.location!.anchors = [{ page: 1, start: 100, end: source.location!.end, kind: 'region',
    rects: [[0.1, 0.2, 0.9, 0.8]] }];
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources).toHaveLength(1);
  expect(packed.sources[0].text).toBe(source.text);
});

it('retains full-document range coverage including paragraph separators', async () => {
  const source = evidence([bdp, performance]);
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources.length).toBeGreaterThan(1);
  expect(packed.sources[0].location!.start).toBe(100);
  expect(packed.sources[0].location!.end).toBe(packed.sources[1].location!.start);
  expect(packed.sources.at(-1)!.location!.end).toBe(source.location!.end);
  const limited = await retrieval.pack([source], bdp.length + 45);
  expect(limited.complete).toBe(false);
});

it('does not split inside a single native text item whose rectangle cannot be narrowed', async () => {
  const source = evidence([bdp, performance]);
  source.location!.anchors = [{ page: 1, start: 100, end: source.location!.end, kind: 'native',
    rects: [[0.1, 0.2, 0.9, 0.8]] }];
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources).toHaveLength(1);
  expect(packed.sources[0].location!.anchors![0].end).toBe(source.location!.end);
});

it('separates OCR paragraphs only when their distinct line geometry is available', async () => {
  const source = evidence([bdp, performance]);
  source.location!.anchors!.forEach(a => { a.kind = 'ocr'; });
  const packed = await retrieval.pack([source], 10000);
  const hit = packed.sources.find(s => s.text.includes('骨架屏'))!;
  expect(hit.text).toBe(performance);
  expect(hit.location!.anchors).toHaveLength(1);
  expect(hit.location!.anchors![0].kind).toBe('ocr');
  expect(retrieval.citationEvidence(packed.sources).map(s => s.evidenceId)).toEqual(packed.sources.map(s => s.evidenceId));
});

it('separates page transitions and keeps each citation on its actual page', async () => {
  const source = evidence([bdp, performance], '\n');
  source.location!.anchors![1].page = 2;
  const packed = await retrieval.pack([source], 10000);
  const hit = packed.sources.find(s => s.text.includes('骨架屏'))!;
  expect(hit.text).toBe(performance);
  expect(hit.location!.page).toBe(2);
  expect(hit.location!.anchors!.map(a => a.page)).toEqual([2]);
});

it('separates distant columns even when their text is stored on the same line', async () => {
  const source = evidence([bdp, performance], ' ');
  source.location!.anchors![0].rects = [[0.1, 0.2, 0.4, 0.22]];
  source.location!.anchors![1].rects = [[0.6, 0.2, 0.9, 0.22]];
  const packed = await retrieval.pack([source], 10000);
  const hit = packed.sources.find(s => s.text.includes('骨架屏'))!;
  expect(hit.text).toBe(performance);
  expect(hit.location!.anchors).toHaveLength(1);
});

it('keeps paragraph-sized references through document summaries, cache reuse and saved history', async () => {
  const store = new MemoryStore(), libraries = new KnowledgeBasesService(store);
  const kb = await store.save('knowledgeBases', { userId: 1, name: 'Test' });
  const revision = await store.save('indexRevisions', {});
  const doc = await store.save('documents', { userId: 1, knowledgeBaseId: kb.id,
    filename: 'resume.pdf', activeIndexRevisionId: revision.id, activeVersionId: 2 });
  const original = evidence([bdp, performance]);
  await store.save('chunks', { documentId: doc.id, versionId: 2, indexRevisionId: revision.id,
    chunkIndex: 0, text: original.text, location: original.location });
  const localRetrieval = new RetrievalService({} as any, {} as any, store, libraries);
  const scope = await localRetrieval.createScope(1, kb.id);
  const session = await localRetrieval.open(scope);
  const config = new ConfigService({ CHAT_CONTEXT_TOKENS: 32768 });
  const tokenizer = { count: async (text: string) => text.length,
    windows: async (text: string) => [{ text }] };
  let calls = 0;
  const llm = { complete: async (prompt: string) => {
    calls++;
    return prompt.startsWith('核查摘要') ? '{"supported":true}' : '骨架屏使首屏加载时长缩短约40%[2]';
  } };
  const summary = new SummaryService(store, llm as any, tokenizer as any, config);
  const tools = new AgentTools(localRetrieval, summary, config, () => ({ model: 'local-test' }));
  const state: any = { scope, userId: 1, knowledgeBaseId: kb.id, question: '总结技术亮点' };
  const call = { id: 'summary', name: 'summarize_document', args: { documentId: doc.id } };
  const first = await tools.execute(call, state, {}, session);
  const result = verifiedSummaryResult({ ...state, evidence: first.evidence,
    summaries: { summary: first.summaryGroups }, summaryCoverage: { summary: first.summaryCoverage } }, 10000)!;
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0].text).toBe(performance);
  expect(result.sources[0].location!.anchors).toHaveLength(1);
  expect(result.complete).toBe(true);
  expect(await summary.agentCacheComplete(localRetrieval.citationEvidence((await localRetrieval.read(session,
    { documentId: doc.id })).evidence), { userId: 1, knowledgeBaseId: kb.id,
    question: state.question, revisions: [revision.id] }, { model: 'local-test' })).toBe(true);
  await tools.execute(call, state, {}, session);
  expect(calls).toBe(2);

  const history = new HistoryService(store, libraries), chat = await history.create('Test', 1, kb.id);
  await history.addMessage(chat.id, 1, 'assistant', result.answer, result.sources);
  const stored = (await history.get(chat.id, 1)).messages[0].citations[0];
  expect(stored.text).toBe(performance);
  expect(stored.location).toEqual(result.sources[0].location);
});

it('keeps generated OCR labels with their own line evidence without creating label-only citations', async () => {
  const label = '[图片文字识别]\n';
  const source = evidence([label + bdp, label + performance]);
  source.location!.anchors!.forEach(a => { a.kind = 'ocr'; a.start += label.length; });
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources).toHaveLength(2);
  expect(packed.sources[0].text).toBe(label + bdp + '\n\n');
  expect(packed.sources[1].text).toBe(label + performance);
  expect(packed.sources.every(s => s.location!.anchors!.length > 0)).toBe(true);
  expect(packed.sources.map(s => s.text).join('')).toBe(source.text);
});

it('does not discard uncovered actual OCR prose while recognizing metadata labels', async () => {
  const source = evidence(['[图片文字识别]\n遗漏的正文' + bdp, performance]);
  source.location!.anchors![0].start += '[图片文字识别]\n遗漏的正文'.length;
  source.location!.anchors!.forEach(a => { a.kind = 'ocr'; });
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources).toHaveLength(1);
  expect(packed.sources[0].text).toBe(source.text);
});
