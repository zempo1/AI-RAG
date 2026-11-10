import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { pipeline } from './helpers/pipeline';
import { HistoryService } from '../src/modules/history/history.service';
import { AgentQaTasksService } from '../src/modules/tasks/agent-qa.service';
import { AgentService } from '../src/modules/agent/agent.service';
import { AgentGraphRun } from '../src/modules/agent/agent-graph-run';
import { MysqlAgentCheckpointer } from '../src/modules/agent/mysql-agent-checkpointer';
import { emptyCheckpoint } from '@langchain/langgraph';
import { AgentBudget } from '../src/modules/agent/agent-budget';

it('hands a native graph thread to a new worker without storing or replaying its plan', async () => {
  const p = await fixture();
  const settings = {
    AGENT_SYNC_MS: 30000, JWT_SECRET: p.config.getOrThrow('JWT_SECRET'),
  };
  const config = new ConfigService(settings);
  let plans = 0, decisions = 0;
  const retrieval = {
    createScope: async () => ({ userId: 1, knowledgeBaseId: p.kb.id, documents: [] }),
    verify: async () => {},
    pack: async () => ({ sources: [], complete: false }),
    context: () => '',
  };
  const llm = {
    complete: async () => {
      plans++;
      settings.AGENT_SYNC_MS = 1;
      return '{"intent":"search","complexity":"simple","subQuestions":["问题"],"ambiguous":false}';
    },
    invokeTools: async () => { decisions++; return { content: '', toolCalls: [] }; },
  };
  const makeServices = () => {
    const agent = new AgentService(retrieval as any, llm as any, {} as any, config, p.store);
    const tasks = new AgentQaTasksService(p.store, new HistoryService(p.store, p.libraries), p.libraries, agent, config);
    return { agent, tasks };
  };
  try {
    const { agent, tasks } = makeServices();
    const started = await tasks.begin(1, p.input);
    const id = started.task.id;
    expect(started.task.payload).toMatchObject({ graphVersion: 2, graphThreadId: `qa:${id}:v2` });
    const execution = tasks.execution(id, started.token!);
    try {
      const context = await agent.prepare(p.input.question, 1, p.kb.id, {
        ...execution, chatId: started.chat.id, apiKey: 'transient-key',
      });
      expect(context.requiresAsync).toBe(true);
      expect(context.snapshot).toBeUndefined();
      await tasks.handoff(id, started.token!);
    } finally { execution.dispose(); }
    expect({ plans, decisions }).toEqual({ plans: 1, decisions: 0 });
    const queued = (await p.store.get('tasks', id))!;
    expect(queued.payload.snapshot).toBeUndefined();
    expect(JSON.stringify(await p.store.list('agentCheckpoints', { threadId: queued.payload.graphThreadId })))
      .not.toContain('transient-key');
    expect(await makeServices().tasks.process(id)).toBe('done');
    expect({ plans, decisions }).toEqual({ plans: 1, decisions: 1 });
    expect((await p.store.list('messages')).map(m => m.role)).toEqual(['user', 'assistant']);
    expect(await p.store.list('agentCheckpoints', { threadId: queued.payload.graphThreadId })).toEqual([]);
  } finally { await p.cleanup(); }
});

it('imports a legacy tool checkpoint into v2 without repeating a journaled tool or resetting the budget', async () => {
  const p = await fixture();
  const started = await p.service.begin(1, p.input);
  const id = started.task.id;
  const scope = { userId: 1, knowledgeBaseId: p.kb.id, documents: [] };
  const run = await p.store.save('retrievalRuns', {
    userId: 1, knowledgeBaseId: p.kb.id, chatId: started.chat.id,
  });
  const call = { id: 'already-done', name: 'keyword_search', args: { query: '旧查询' } };
  const { graphVersion, graphThreadId, ...payload } = started.task.payload;
  await p.store.save('tasks', { id, status: 'queued', executionToken: null, payload: {
    ...payload, foreground: false, leaseUntil: null, retrievalRunId: run.id,
    snapshot: {
      engine: 'agentic-v1', runId: run.id, phase: 'tool', userId: 1, knowledgeBaseId: p.kb.id,
      chatId: started.chat.id, question: p.input.question, scope, history: [], steps: [],
      plan: { intent: 'search', complexity: 'simple', subQuestions: [p.input.question] },
      budget: { ...AgentBudget.initial(), calls: 3, tokens: 91, tools: 1 },
      pending: [call], journal: { [JSON.stringify([call.name, call.args])]: '{"evidence":[]}' },
      messages: [], evidence: [], noProgress: 0, repairUsed: false,
    },
  } });
  const fail = async () => { throw new Error('不得重做已完成工作'); };
  const agent = new AgentService({
    createScope: fail, search: fail, open: fail, verify: async () => {},
    pack: async () => ({ sources: [], complete: false }), context: () => '',
  } as any, {
    complete: fail,
    invokeTools: async () => {
      expect((await p.store.get('tasks', id))?.payload.snapshot).toBeUndefined();
      return { content: '', toolCalls: [] };
    },
  } as any, {} as any, p.config, p.store);
  const service = new AgentQaTasksService(p.store, new HistoryService(p.store, p.libraries), p.libraries, agent, p.config);
  const put = MysqlAgentCheckpointer.prototype.put;
  let failedImport = false;
  const failOnce = jest.spyOn(MysqlAgentCheckpointer.prototype, 'put').mockImplementation(function (
    this: MysqlAgentCheckpointer, config, checkpoint, metadata,
  ) {
    if (checkpoint.channel_values.input && !failedImport) {
      failedImport = true;
      return Promise.reject(new Error('首次图输入写入失败'));
    }
    return put.call(this, config, checkpoint, metadata);
  });
  try {
    await expect(service.process(id)).rejects.toThrow('首次图输入写入失败');
    const retrying = (await p.store.get('tasks', id))!;
    expect(retrying.payload.snapshot.phase).toBe('tool');
    expect(retrying.payload.agentBudgetLedger.budget.calls).toBe(3);
    expect(await service.process(id, 2)).toBe('done');
    const result = (await p.store.get('tasks', id))!;
    expect(result.payload.graphVersion).toBe(2);
    expect(result.payload.snapshot).toBeUndefined();
    expect(result.payload.retrievalRunId).toBe(run.id);
    expect(result.payload.agentProgress.budget).toMatchObject({ calls: 3, tokens: 91, tools: 1 });
  } finally {
    failOnce.mockRestore();
    await p.cleanup();
  }
});

it('publishes v2 progress without replacing the durable budget ledger', async () => {
  const p = await fixture();
  try {
    const started = await p.service.begin(1, p.input);
    const run = await p.store.save('retrievalRuns', { userId: 1, knowledgeBaseId: p.kb.id });
    const owner = { taskId: started.task.id, token: started.token! };
    const graph = new AgentGraphRun(p.store, owner, { budget: AgentBudget.initial(), repairUsed: false }, []);
    const draft = { runId: run.id, engine: 'agentic-v1', phase: 'plan', plan: null } as any;
    graph.budget.calls = 3;
    await Promise.all([
      graph.charge(draft),
      graph.publish('plan', draft, { runId: run.id, sequence: 0, kind: 'plan', summary: '规划' }),
    ]);
    const payload = (await p.store.get('tasks', owner.taskId))!.payload;
    expect(payload.agentBudgetLedger.budget.calls).toBe(3);
    expect(payload.agentProgress.steps).toMatchObject([{ sequence: 1, kind: 'plan' }]);
  } finally { await p.cleanup(); }
});

it('cancel clears ownership and records an interrupted history message', async () => {
  const p = await fixture();
  try {
    const started = await p.service.begin(1, p.input);
    await p.service.cancel(started.task.id, 1);
    await p.service.fail(started.task.id, started.token!, new Error('aborted'));
    const task = (await p.store.get('tasks', started.task.id))!;
    expect(task.executionToken).toBeNull();
    expect(task.payload.leaseUntil).toBeNull();
    const messages = (await p.store.list('messages')).filter(m => m.role === 'assistant');
    expect(messages).toHaveLength(1);
    expect(messages[0].generationStatus).toBe('interrupted');
    await expect(p.tasks.dismiss(task.id, 1)).resolves.toEqual({ removed: true });
  } finally { await p.cleanup(); }
});

it('final background failure stores one interrupted answer and successful retry replaces it without resetting budget', async () => {
  const p = await fixture();
  try {
    const started = await p.service.begin(1, p.input);
    await p.store.save('tasks', { id: started.task.id, payload: { ...started.task.payload,
      agentBudgetLedger: { budget: { ...AgentBudget.initial(), calls: 9 }, repairUsed: false },
    } });
    await p.service.fail(started.task.id, started.token!, new Error('outage'), 3, true);
    const failed = (await p.store.get('tasks', started.task.id))!;
    expect(failed.payload.messageId).toEqual(expect.any(Number));
    expect((await p.store.get('messages', failed.payload.messageId))?.generationStatus).toBe('interrupted');
    await p.tasks.retry(started.task.id, 1);
    jest.spyOn(p.agent, 'prepare').mockImplementationOnce(async () => {
      expect((await p.store.get('tasks', started.task.id))?.payload.agentBudgetLedger.budget.calls).toBe(9);
      return {};
    });
    await p.service.process(started.task.id);
    const messages = (await p.store.list('messages')).filter(m => m.role === 'assistant');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: failed.payload.messageId, generationStatus: 'completed' });
  } finally { await p.cleanup(); }
});

it('final transaction checks the latest checkpoint scope', async () => {
  const p = await fixture();
  try {
    const accepted = await p.documents.ingest(Buffer.from('原文'), 'fresh.md', 1);
    await p.indexing.process(accepted.taskId);
    const doc = (await p.store.get('documents', accepted.documentId))!;
    const started = await p.service.begin(1, p.input);
    const guard = p.service.guard.bind(p.service);
    jest.spyOn(p.service, 'guard').mockImplementationOnce(async (...args) => {
      const row = await guard(...args);
      await p.store.save('tasks', { id: row.id, payload: { ...row.payload, graphScope: { documents: [{ documentId: doc.id, indexRevisionId: doc.activeIndexRevisionId + 1 }] } } });
      return row;
    });
    await expect(p.service.complete(started.task.id, started.token!, { answer: '不得提交' })).rejects.toThrow('索引');
  } finally { await p.cleanup(); }
});

async function fixture() {
  const p = await pipeline();
  const agent = {
    prepare: async () => ({}),
    answerPrepared: async () => ({ answer: '有依据的回答', citations: [], diagnostics: { agent: { status: 'completed' } } }),
  };
  const service = new AgentQaTasksService(p.store, new HistoryService(p.store, p.libraries), p.libraries, agent as any, p.config);
  const kb = await p.libraries.default(1);
  const input = { question: '文档是什么？', knowledgeBaseId: kb.id, requestId: 'same-request', fingerprint: 'fingerprint', mode: 'auto' };
  return { ...p, service, agent, kb, input };
}

it('reserves one foreground task, chat and user message across concurrent requestId retries', async () => {
  const p = await fixture();
  try {
    const [a, b] = await Promise.all([p.service.begin(1, p.input), p.service.begin(1, p.input)]);
    expect(a.task.id).toBe(b.task.id);
    expect([a.existing, b.existing].filter(Boolean)).toHaveLength(1);
    expect(await p.store.list('chats')).toHaveLength(1);
    expect(await p.store.list('messages')).toHaveLength(1);
    expect(await p.store.list('tasks')).toHaveLength(1);
    await expect(p.service.begin(1, { ...p.input, fingerprint: 'different' })).rejects.toThrow('requestId');
  } finally { await p.cleanup(); }
});

it('requires a durable graph pause before transferring ownership', async () => {
  const p = await fixture();
  try {
    const started = await p.service.begin(1, p.input);
    await expect(p.service.handoff(started.task.id, started.token!)).rejects.toThrow('暂停尚未持久化');
    expect((await p.store.get('tasks', started.task.id))?.executionToken).toBe(started.token);
  } finally { await p.cleanup(); }
});

it('only cancels the owning user Agent task and prevents an old executor publishing', async () => {
  const p = await fixture();
  try {
    const started = await p.service.begin(1, p.input);
    await expect(p.service.cancel(started.task.id, 2)).rejects.toThrow();
    await p.service.cancel(started.task.id, 1);
    await expect(p.service.guard(started.task.id, started.token!)).rejects.toThrow();
    await expect(p.service.complete(started.task.id, started.token!, { answer: '不应发布', citations: [] })).rejects.toThrow();
    expect((await p.store.list('messages')).filter(m => m.role === 'assistant' && m.generationStatus === 'completed')).toHaveLength(0);
  } finally { await p.cleanup(); }
});

it('rechecks published revisions transactionally before committing an answer', async () => {
  const p = await fixture();
  try {
    const accepted = await p.documents.ingest(Buffer.from('第一版原文'), 'scope.md', 1);
    await p.indexing.process(accepted.taskId);
    const doc = (await p.store.get('documents', accepted.documentId))!;
    const started = await p.service.begin(1, { ...p.input, knowledgeBaseId: doc.knowledgeBaseId });
    await p.store.save('tasks', { id: started.task.id, payload: { ...started.task.payload,
      graphScope: { userId: 1, knowledgeBaseId: doc.knowledgeBaseId, documents: [{ documentId: doc.id, indexRevisionId: doc.activeIndexRevisionId }] },
    } });
    await p.store.save('documents', { id: doc.id, activeIndexRevisionId: doc.activeIndexRevisionId + 1 });
    await expect(p.service.complete(started.task.id, started.token!, { answer: '旧版答案', citations: [] })).rejects.toThrow('索引');
    expect((await p.store.list('messages')).filter(m => m.role === 'assistant' && m.generationStatus === 'completed')).toHaveLength(0);
  } finally { await p.cleanup(); }
});

it('retains failed foreground counters on manual retry and hides credentials and internal state', async () => {
  const p = await fixture();
  try {
    const started = await p.service.begin(1, { ...p.input, apiKey: 'private-test-api-key' });
    await p.store.save('tasks', { id: started.task.id, payload: { ...started.task.payload,
      agentBudgetLedger: { budget: { ...AgentBudget.initial(), calls: 9 }, repairUsed: false },
    } });
    const saver = new MysqlAgentCheckpointer(p.store, { taskId: started.task.id, token: started.token! });
    await saver.put({ configurable: { thread_id: started.task.payload.graphThreadId } },
      { ...emptyCheckpoint(), channel_values: { messages: ['internal prompt'] } },
      { source: 'input', step: -1, parents: {} });
    await p.service.fail(started.task.id, started.token!, new Error('temporary outage'));
    const retried = await p.tasks.retry(started.task.id, 1);
    expect((await p.store.get('tasks', started.task.id))?.payload.agentBudgetLedger.budget.calls).toBe(9);
    const serialized = JSON.stringify(retried);
    expect(serialized).not.toContain('private-test-api-key');
    expect(serialized).not.toContain('internal prompt');
  } finally { await p.cleanup(); }
});

