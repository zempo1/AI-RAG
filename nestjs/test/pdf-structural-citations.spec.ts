import { RetrievalService } from '../src/modules/rag/retrieval.service';
import type { OriginalEvidence } from '../src/modules/rag/retrieval.types';
import { withoutSourceGeometry } from '../src/modules/documents/parsers/source-anchors';
import { MemoryStore } from '../src/persistence/memory.store';
import { KnowledgeBasesService } from '../src/modules/knowledge-bases/knowledge-bases.service';
import { AgentService } from '../src/modules/agent/agent.service';
import { HistoryService } from '../src/modules/history/history.service';

const retrieval = new RetrievalService({} as any, {} as any, {} as any, {} as any);
function fixture() {
  // PDF storage order differs from the physical order: performance is stored first.
  const lines = [
    { text: '骨架屏将首屏加载时长缩短40%', page: 1, y: .65 },
    { text: '甲医院——前端开发实习生 2026.4-2026.9', page: 1, y: .15 },
    { text: '主要职责：', page: 1, y: .2 },
    { text: '基于Jarvis框架承接定制化开发', page: 1, y: .24 },
    { text: '基于BDP配置进行按钮级管控', page: 1, y: .28 },
    { text: '乙科技有限公司——前端开发实习生 2025.9-2026.1', page: 1, y: .5 },
    { text: '主要职责：', page: 1, y: .55 },
    { text: '使用Canvas生成分享海报', page: 1, y: .69 },
    { text: '知识库RAG系统 2025.11-至今', page: 1, y: .8 },
    { text: '使用Vue3和NestJS开发', page: 1, y: .85 },
    { text: '混合检索与Rerank优化', page: 2, y: .1 },
    { text: 'SSE流式输出', page: 2, y: .14 },
  ];
  return { source: fromLines(lines), lines };
}
function fromLines(lines: { text: string; page: number; y: number; box?: [number, number, number, number] }[]): OriginalEvidence {
  const text = lines.map(l => l.text).join('\n\n');
  let at = 100;
  const anchors = lines.map(line => {
    const a = { start: at, end: at + line.text.length, page: line.page, kind: 'native' as const,
      rects: [line.box || [.1, line.y, .9, line.y + .02] as [number, number, number, number]] };
    at = a.end + 2; return a;
  });
  const source = retrieval.original({ number: 0, documentId: 1, knowledgeBaseId: 1, versionId: 2,
    indexRevisionId: 3, chunkId: 4, filename: 'resume.pdf', text, score: 1,
    location: { start: 100, end: 100 + text.length, page: 1, paragraph: 1, heading: null, anchorVersion: 1, anchors } });
  return source;
}

it('uses one complete internship per citation instead of making each line a source', async () => {
  const { source } = fixture();
  const packed = await retrieval.pack([source], 10000, { readingOrder: true });
  expect(packed.sources).toHaveLength(3);
  const hospital = packed.sources.find(s => s.text.includes('甲医院'))!;
  expect(hospital.text).toContain('Jarvis');
  expect(hospital.text).toContain('BDP');
  expect(hospital.text).not.toContain('骨架屏');
  expect(hospital.sectionTitle).toContain('甲医院');
  const performance = packed.sources.find(s => s.text.includes('骨架屏'))!;
  expect(performance.text).toContain('乙科技有限公司');
  expect(performance.text).toContain('Canvas');
  expect(performance.text).not.toContain('BDP');
  expect(packed.complete).toBe(true);
});

it('preserves a project across a page break and records exact slices rather than a fake contiguous span', async () => {
  const { source } = fixture();
  const packed = await retrieval.pack([source], 10000);
  const project = packed.sources.find(s => s.sectionTitle?.includes('RAG'))!;
  expect(project.text).toContain('Vue3');
  expect(project.text).toContain('Rerank');
  expect(project.text).toContain('SSE');
  expect([...new Set(project.location!.anchors!.map(a => a.page))]).toEqual([1, 2]);
  for (const group of packed.sources) for (const segment of group.sourceSegments!)
    expect(segment.text).toBe(source.text.slice(segment.location.start - 100, segment.location.end - 100));
});

it('deduplicates overlapping retrieval chunks without losing native text or multiplying citations', async () => {
  const { source, lines } = fixture();
  const packed = await retrieval.pack([source, { ...source, chunkId: 5 }], 10000);
  expect(packed.sources).toHaveLength(3);
  for (const line of lines) expect(packed.sources.map(s => s.text).join('\n').split(line.text))
    .toHaveLength(line.text === '主要职责：' ? 3 : 2);
  expect(packed.sources.every(s => s.chunkIds?.includes(4) && s.chunkIds?.includes(5))).toBe(true);
  const again = await retrieval.pack(packed.sources, 10000);
  expect(again.sources.map(s => s.evidenceId)).toEqual(packed.sources.map(s => s.evidenceId));
});

it('keeps internal slices out of model and history budgeting while retaining the readable group snapshot', async () => {
  const { source } = fixture();
  const packed = await retrieval.pack([source], 10000);
  const cleaned = JSON.stringify(withoutSourceGeometry(packed.sources));
  expect(cleaned).not.toContain('sourceSegments');
  expect(cleaned).not.toContain('anchors');
  expect(cleaned).toContain('Jarvis');
  expect(retrieval.context(packed.sources)).not.toContain('sourceSegments');
});

it('checks exact internal ranges for full coverage and preserves them in historical snapshots', async () => {
  const { source } = fixture(), store = new MemoryStore(), libraries = new KnowledgeBasesService(store);
  const kb = await store.save('knowledgeBases', { userId: 1, name: 'test' });
  const revision = await store.save('indexRevisions', {});
  const doc = await store.save('documents', { userId: 1, knowledgeBaseId: kb.id,
    filename: source.filename, activeIndexRevisionId: revision.id, activeVersionId: 2 });
  await store.save('chunks', { documentId: doc.id, versionId: 2, indexRevisionId: revision.id,
    chunkIndex: 0, text: source.text, location: source.location });
  const service = new RetrievalService({} as any, {} as any, store, libraries);
  const scope = await service.createScope(1, kb.id), session = await service.open(scope);
  const raw = await service.read(session, { documentId: doc.id });
  const packed = await service.pack(raw.evidence, 10000);
  const agent = new AgentService(service, {} as any, {} as any, { get: () => undefined } as any, store);
  expect(await (agent as any).overviewCovered({ scope }, packed.sources, {})).toBe(true);
  const incomplete = structuredClone(packed.sources);
  const employer = incomplete.find(s => s.text.includes('骨架屏'))!;
  employer.sourceSegments = employer.sourceSegments!.filter(s => !s.text.includes('骨架屏'));
  expect(await (agent as any).overviewCovered({ scope }, incomplete, {})).toBe(false);
  const history = new HistoryService(store, libraries), chat = await history.create('test', 1, kb.id);
  await history.addMessage(chat.id, 1, 'assistant', '实习技术亮点[1]', [packed.sources[0]]);
  await store.delete('chunks', session.chunks[0].id);
  expect((await history.get(chat.id, 1)).messages[0].citations[0].sourceSegments).toEqual(packed.sources[0].sourceSegments);
});

it('keeps numbered responsibilities within their named project rather than treating each as a section', async () => {
  const source = fromLines([
    { text: '项目经历', page: 1, y: .1 },
    { text: '知识库RAG系统 2025.11-至今', page: 1, y: .15 },
    { text: '1. 完成混合检索和召回优化', page: 1, y: .2 },
    { text: '2. 实现SSE流式输出与断点恢复', page: 1, y: .25 },
  ]);
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources).toHaveLength(1);
  expect(packed.sources[0].text).toContain('混合检索');
  expect(packed.sources[0].text).toContain('SSE');
});

it('does not combine two visible prose columns even when only two rows are available', async () => {
  const source = fromLines([
    { text: '知识库RAG系统 2025.11-至今', page: 1, y: .2, box: [.05, .2, .45, .22] },
    { text: '教育背景', page: 1, y: .2, box: [.6, .2, .95, .22] },
    { text: '开发混合检索和召回优化功能', page: 1, y: .3, box: [.05, .3, .45, .32] },
    { text: '某大学计算机科学本科', page: 1, y: .3, box: [.6, .3, .95, .32] },
  ]);
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources.some(s => s.text.includes('知识库RAG') && s.text.includes('教育背景'))).toBe(false);
});

it('deduplicates a mixture of raw retrieval and previously grouped tool evidence', async () => {
  const { source } = fixture();
  const grouped = retrieval.citationEvidence([source]);
  const mixed = await retrieval.pack([source, ...grouped], 10000);
  expect(mixed.sources).toHaveLength(3);
  expect(new Set(mixed.sources.map(s => s.evidenceId)).size).toBe(3);
  expect(mixed.sources.map(s => s.text)).toEqual(grouped.map(s => s.text));
});

it('also treats short narrow prose columns as ambiguous instead of joining their headings', async () => {
  const source = fromLines([
    { text: '项目经历', page: 1, y: .1, box: [.05, .1, .22, .12] },
    { text: '知识库RAG系统 2025.11-至今', page: 1, y: .2, box: [.05, .2, .22, .22] },
    { text: '教育背景', page: 1, y: .2, box: [.6, .2, .78, .22] },
  ]);
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources.some(s => s.text.includes('知识库RAG') && s.text.includes('教育背景'))).toBe(false);
});
