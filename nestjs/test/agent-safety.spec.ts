import { AgentService } from '../src/modules/agent/agent.service';
import { AgentBudget } from '../src/modules/agent/agent-budget';
import { jest } from '@jest/globals';

const scope = {
  userId: 1,
  knowledgeBaseId: 2,
  documents: [{ documentId: 3, filename: '资料', indexRevisionId: 4 }],
};
const evidence: any = {
  evidenceId: 'ev1',
  number: 0,
  documentId: 3,
  knowledgeBaseId: 2,
  versionId: 1,
  indexRevisionId: 4,
  chunkId: 5,
  filename: '资料',
  text: 'CRC用于差错检测',
  location: null,
  score: 0.9,
};
function setup(extra: Record<string, any> = {}) {
  const retrieval: any = {
    createScope: async () => structuredClone(scope),
    verify: async () => {},
    open: async () => ({ scope }),
    search: async () => ({ evidence: [evidence] }),
    pack: async (items: any[]) => ({
      sources: items.map((e, i) => ({ ...e, number: i + 1 })),
      complete: true,
    }),
    context: (items: any[]) => items.map((e) => `[${e.number}] ${e.text}`).join('\n'),
  };
  const llm: any = {
    complete: async (prompt: string) =>
      prompt.startsWith('分析用户问题')
        ? JSON.stringify({
            intent: 'search',
            complexity: 'simple',
            subQuestions: ['CRC作用'],
            ambiguous: false,
          })
        : JSON.stringify({
            supported: true,
            subQuestions: [{ question: 'CRC作用', status: 'supported', evidenceIds: ['ev1'] }],
          }),
    invokeTools: jest
      .fn<any>()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'a', name: 'keyword_search', args: { query: 'CRC' } }],
      })
      .mockResolvedValue({ content: '申请作答', toolCalls: [] }),
  };
  const store: any = { save: async (_t: string, row: any) => ({ id: 7, ...row }) };
  const service = new AgentService(
    retrieval,
    llm,
    {} as any,
    { get: (k: string) => extra[k] } as any,
    store,
  );
  return { service, retrieval, llm, store };
}

it('turns model-budget exhaustion into a terminal business result with counters preserved', async () => {
  const p = setup({ AGENT_MODEL_CALLS: 2 });
  p.llm.complete = async (
    _prompt: string,
    _key: any,
    _images: any,
    _signal: any,
    execution: any,
  ) => {
    const id = await execution.observer.before({
      kind: 'complete',
      model: 'test',
      input: 'p',
      maxOutputTokens: 10,
    });
    await execution.observer.settle(id, { status: 'success' });
    return JSON.stringify({
      intent: 'search',
      complexity: 'simple',
      subQuestions: ['CRC作用'],
      ambiguous: false,
    });
  };
  p.llm.invokeTools = async (_m: any, _t: any, execution: any) => {
    await execution.observer.before({
      kind: 'tools',
      model: 'test',
      input: 'p',
      maxOutputTokens: 10,
    });
    throw new Error('must not reach provider');
  };
  const context = await p.service.prepare('CRC作用', 1, 2);
  expect(context.requiresAsync).toBe(false);
  expect(context.agentSnapshot.budget.calls).toBe(1);
  expect(context.directAnswer).toMatch(/预算|上限/);
  expect(context.diagnostics.agent.stopReason).toBe('budget_exhausted');
});

it('fills two independent tool slots and preserves returned tool-call order', async () => {
  const p = setup();
  let active = 0,
    peak = 0;
  p.retrieval.search = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    return { evidence: [evidence] };
  };
  p.llm.invokeTools = jest
    .fn<any>()
    .mockResolvedValueOnce({
      content: '',
      toolCalls: [
        { id: 'first', name: 'keyword_search', args: { query: 'CRC' } },
        { id: 'second', name: 'knowledge_search', args: { query: '差错' } },
      ],
    })
    .mockResolvedValue({ content: '申请作答', toolCalls: [] });
  const context = await p.service.prepare('CRC作用', 1, 2);
  expect(peak).toBe(2);
  expect(
    context.agentSnapshot.messages.filter((m) => m.role === 'tool').map((m: any) => m.tool_call_id),
  ).toEqual(['first', 'second']);
});

it('caches repeated lookups but still counts their decisions and stops without progress', async () => {
  const p = setup();
  p.retrieval.search = jest.fn<any>().mockResolvedValue({ evidence: [evidence] });
  p.llm.invokeTools = async () => ({
    content: '',
    toolCalls: [{ id: 'same', name: 'keyword_search', args: { query: 'CRC' } }],
  });
  const result = await p.service.prepare('CRC作用', 1, 2);
  expect(p.retrieval.search).toHaveBeenCalledTimes(1);
  expect(result.agentSnapshot.budget.decisions).toBe(3);
  expect(result.agentSnapshot.budget.assessments).toBe(1);
  expect(result.diagnostics.agent.stopReason).toBe('supported');
  expect(result.directAnswer).toBeUndefined();
});

it('uses bounded original evidence for a grounded answer when the assessment cannot confirm full coverage', async () => {
  const p = setup({ AGENT_DECISIONS: 1 });
  const plan = p.llm.complete;
  p.llm.complete = jest.fn(async (prompt: string) => {
    if (prompt.startsWith('分析用户问题')) return plan(prompt);
    if (prompt.startsWith('检查原文'))
      return JSON.stringify({ supported: false, missing: ['CRC作用'] });
    expect(prompt).toContain('[1] CRC用于差错检测');
    expect(prompt).toContain('仅回答原文明确支持的部分');
    return 'CRC用于差错检测[1]。';
  });
  const result = await p.service.prepare('CRC作用', 1, 2);
  expect(result.agentSnapshot.budget.decisions).toBe(1);
  expect(result.agentSnapshot.budget.assessments).toBe(1);
  expect(result.diagnostics.agent.stopReason).toBe('insufficient_evidence');
  expect(result.directAnswer).toBeUndefined();
  const answer = await p.service.answerPrepared(result);
  expect(answer.diagnostics.agent.status).toBe('partial');
  expect(p.llm.complete).toHaveBeenCalledTimes(3);
});

it.each([
  'CSMA/CD协议的工作流程是什么',
  '总结这份文档中的CSMA/CD协议工作流程',
])('answers %s from page 102 even when the planner proposes a full overview', async (question) => {
  const p = setup();
  const source = {
    ...evidence,
    text: 'CSMA/CD协议工作流程：封装成帧、侦听信道、检测冲突、退避重传。',
    location: { page: 102, start: 0, end: 30 },
  };
  p.retrieval.search = async () => ({ evidence: [source] });
  p.retrieval.open = async () => ({
    scope,
    chunks: [
      { id: 5, documentId: 3, location: source.location },
      { id: 6, documentId: 3, text: '其他章节' },
    ],
  });
  p.llm.complete = jest.fn(async (prompt: string) => {
    if (prompt.startsWith('分析用户问题'))
      return JSON.stringify({
        intent: 'overview',
        complexity: 'simple',
        subQuestions: ['CSMA/CD的定义是什么', question],
        ambiguous: false,
      });
    if (prompt.startsWith('检查原文'))
      return JSON.stringify({
        supported: true,
        subQuestions: [{ question, status: 'supported', evidenceIds: ['ev1'] }],
      });
    expect(prompt).toContain(source.text);
    return '先封装成帧，侦听信道，检测冲突后退避重传[1]。';
  });
  const result = await p.service.prepare(question, 1, 2, { documentIds: [3] });
  expect(result.diagnostics.agent.plan).toMatchObject({
    intent: 'search',
    subQuestions: [question],
  });
  const answer = await p.service.answerPrepared(result);
  expect(answer.answer).toContain('退避重传');
  expect(answer.citations[0].location?.page).toBe(102);
});

it('does not count time spent paused in a queue as active execution', async () => {
  const p = setup();
  const snapshot: any = {
    engine: 'agentic-v1',
    userId: 1,
    knowledgeBaseId: 2,
    question: 'CRC作用',
    runId: 7,
    scope,
    plan: { intent: 'search', subQuestions: ['CRC作用'], complexity: 'simple' },
    steps: [],
    budget: { ...AgentBudget.initial(), activeMs: 50 },
    phase: 'finalize',
    evidence: [],
    messages: [],
    pending: [],
    journal: {},
    noProgress: 0,
    repairUsed: false,
    history: [],
    directAnswer: '资料不足',
  };
  const result = await p.service.resume(snapshot, { background: true });
  expect(result.agentSnapshot.budget.activeMs).toBeGreaterThanOrEqual(50);
  expect(result.agentSnapshot.budget.activeMs).toBeLessThan(1000);
});

it.each([
  { intent: 'overview', output: 4096 },
  { intent: 'search', output: 128 },
])('resumes a single-document overview when the planner proposes $intent', async ({ intent, output }) => {
  const p = setup({ CHAT_OUTPUT_TOKENS: output });
  const question = '总结这篇论文内容';
  const second = { ...evidence, evidenceId: 'ev2', text: '另一页原文', chunkId: 6 };
  p.retrieval.read = async (_session: any, input: any) => input.cursor === 1
    ? { evidence: [second], complete: true }
    : { evidence: [evidence], complete: false, nextCursor: 1 };
  p.retrieval.pack = async () => ({ sources: [], complete: false });
  p.llm.complete = async () => JSON.stringify({
    intent, complexity: 'simple', subQuestions: [question], ambiguous: false,
  });
  const summarizeAgent = jest.fn(async (_sources: any[]) => ({
    groups: [{
      summary: 'CRC用于差错检测[1]。' + (output === 128 ? '另一页要点[2]。'.repeat(12) : ''),
      refs: { '1': 'ev1', '2': 'ev2' },
    }],
    coverage: { complete: true, totalSections: 1, completedSections: 1 },
  }));
  (p.service as any).summary = { summarizeAgent };
  const accepted = await p.service.prepare(question, 1, 2, { documentIds: [3] });
  expect(accepted.requiresAsync).toBe(true);
  expect(accepted.snapshot.pending[0]).toMatchObject({
    name: 'summarize_document', args: { documentId: 3 },
  });
  const result = await p.service.resume(accepted.snapshot, { background: true });
  expect(summarizeAgent.mock.calls[0][0]).toEqual([evidence, second]);
  expect(p.llm.invokeTools).not.toHaveBeenCalled();
  if (output === 128) {
    expect(result.directAnswer).toBeUndefined();
    expect(result.prompt).toContain('CRC用于差错检测[1]');
    expect(result.prompt).toContain('另一页要点[2]');
    expect(result.sources[1].evidenceId).toBe('ev2');
  } else expect(result.directAnswer).toContain('CRC用于差错检测[1]');
  expect(result.sources[0].evidenceId).toBe('ev1');
});

it('returns verified summary sections with original citations and an explicit partial notice', async () => {
  const p = setup();
  p.retrieval.pack = async () => ({ sources: [], complete: false });
  const snapshot: any = {
    engine: 'agentic-v1',
    userId: 1,
    knowledgeBaseId: 2,
    question: '总结全文',
    runId: 7,
    scope,
    plan: { intent: 'overview', subQuestions: ['总结全文'], complexity: 'complex' },
    steps: [],
    budget: AgentBudget.initial(),
    phase: 'finalize',
    evidence: [evidence],
    messages: [],
    pending: [],
    journal: {},
    noProgress: 0,
    repairUsed: false,
    history: [],
    directAnswer: '资料不足',
    summaries: { first: [{ summary: 'CRC用于差错检测[1]', refs: { '1': 'ev1' } }] },
    summaryCoverage: { first: { totalSections: 3, completedSections: 1, complete: false } },
  };
  const context = await (p.service as any).context(snapshot, {}, false);
  expect(context.directAnswer).toContain('CRC用于差错检测[1]');
  expect(context.directAnswer).toContain('部分');
  expect(context.sources[0].text).toBe(evidence.text);
  expect(context.coverageComplete).toBe(false);
});

it.each([
  { question: '概览全部文件', mode: 'auto' },
  { question: '总结这篇论文内容', mode: 'auto' },
  { question: '给我看一下', mode: 'overview' },
] as const)('requires full coverage for an overview requested with $mode mode', async ({ question, mode }) => {
  const p = setup();
  const second = { documentId: 9, filename: '第二份', indexRevisionId: 10 };
  p.retrieval.createScope = async () => ({ ...scope, documents: [...scope.documents, second] });
  p.retrieval.open = async () => ({
    scope,
    chunks: [
      { id: 5, documentId: 3, indexRevisionId: 4, text: evidence.text, location: null },
      {
        id: 11,
        documentId: 9,
        indexRevisionId: 10,
        text: '另一份文档的未读取原文',
        location: null,
      },
    ],
  });
  p.llm.complete = async (prompt: string) =>
    prompt.startsWith('分析用户问题')
      ? JSON.stringify({
          intent: 'overview',
          complexity: 'complex',
          subQuestions: ['CRC作用'],
          ambiguous: false,
        })
      : JSON.stringify({
          supported: true,
          subQuestions: [{ question: 'CRC作用', status: 'supported', evidenceIds: ['ev1'] }],
        });
  const context = await p.service.prepare(question, 1, 2, { evaluation: 'single-round', mode });
  expect(context.diagnostics.agent.plan.intent).toBe('overview');
  expect(context.coverageComplete).toBe(false);
  expect(context.directAnswer).toContain('不足');
});

it('rebinds the final short read window to its own evidence identity and offsets', async () => {
  const p = setup();
  p.retrieval.read = async () => ({
    evidence: [{ ...evidence, text: 'a'.repeat(3000), location: { start: 0, end: 3000 } }],
    complete: true,
  });
  p.retrieval.original = (e: any) => ({
    ...e,
    evidenceId: `window-${e.location.start}-${e.location.end}`,
  });
  const result = JSON.parse(
    (
      await (p.service as any).tool(
        { name: 'read_document', args: { documentId: 3, offset: 2400 } },
        { scope, evidence: [] },
        {},
        {},
      )
    ).output,
  );
  expect(result.evidence[0].evidenceId).toBe('window-2400-3000');
  expect(result.evidence[0].text).toHaveLength(600);
});

it('resumes after a persisted tool_end without appending its tool result a second time', async () => {
  const p = setup();
  let saved: any;
  await expect(
    p.service.prepare('CRC作用', 1, 2, {
      onCheckpoint: async (snapshot) => {
        saved = structuredClone(snapshot);
      },
      onAgentStep: (step) => {
        if (step.kind === 'tool_end') throw new Error('simulate crash');
      },
    }),
  ).rejects.toThrow('simulate crash');
  await p.service.resume(saved, { background: true });
  const messages: any[] = p.llm.invokeTools.mock.calls.at(-1)[0];
  expect(messages.filter((m) => m.role === 'tool' && m.tool_call_id === 'a')).toHaveLength(1);
});
