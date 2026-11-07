import { jest } from '@jest/globals';
import { pipeline } from './helpers/pipeline';
import { HistoryService } from '../src/modules/history/history.service';
import { AgentQaTasksService } from '../src/modules/tasks/agent-qa.service';

it('progress callbacks cannot overwrite a concurrent durable budget reservation', async () => {
  const p = await fixture();
  try {
    const started = await p.service.begin(1, p.input);
    const snap = { userId: 1, knowledgeBaseId: p.kb.id, budget: { modelCalls: 2 }, steps: [] };
    await p.service.checkpoint(started.task.id, started.token!, snap);
    const guard = p.service.guard.bind(p.service);
    let updated = false;
    jest.spyOn(p.service, 'guard').mockImplementation(async (...args) => {
      const row = await guard(...args);
      if (!updated) {
        updated = true;
        await p.store.save('tasks', { id: row.id, payload: { ...row.payload,
          snapshot: { ...snap, budget: { modelCalls: 3 } } } });
      }
      return row;
    });
    await p.service.step(started.task.id, started.token!, { runId: 1, sequence: 1, kind: 'plan', summary: '规划' });
    expect((await p.store.get('tasks', started.task.id))?.payload.snapshot.budget.modelCalls).toBe(3);
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
    const snapshot = { userId: 1, knowledgeBaseId: p.kb.id, budget: { modelCalls: 9 }, steps: [], scope: { documents: [] } };
    await p.service.checkpoint(started.task.id, started.token!, snapshot);
    await p.service.fail(started.task.id, started.token!, new Error('outage'), 3, true);
    const failed = (await p.store.get('tasks', started.task.id))!;
    expect(failed.payload.messageId).toEqual(expect.any(Number));
    expect((await p.store.get('messages', failed.payload.messageId))?.generationStatus).toBe('interrupted');
    await p.tasks.retry(started.task.id, 1);
    await p.service.process(started.task.id);
    const messages = (await p.store.list('messages')).filter(m => m.role === 'assistant');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: failed.payload.messageId, generationStatus: 'completed' });
    expect((await p.store.get('tasks', started.task.id))?.payload.snapshot.budget.modelCalls).toBe(9);
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
      await p.store.save('tasks', { id: row.id, payload: { ...row.payload, snapshot: {
        scope: { documents: [{ documentId: doc.id, indexRevisionId: doc.activeIndexRevisionId + 1 }] } } } });
      return row;
    });
    await expect(p.service.complete(started.task.id, started.token!, { answer: '不得提交' })).rejects.toThrow('索引');
  } finally { await p.cleanup(); }
});

async function fixture() {
  const p = await pipeline();
  const agent = {
    resume: async (snapshot: any) => ({ engine: 'agentic-v1', agentSnapshot: snapshot }),
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

it('checkpoints budget before handoff and resumes the same task without a second user message', async () => {
  const p = await fixture();
  try {
    const started = await p.service.begin(1, p.input);
    const snapshot = { engine: 'agentic-v1', question: p.input.question, userId: 1, knowledgeBaseId: p.kb.id,
      chatId: started.chat.id, runId: 42, phase: 'tools', scope: { userId: 1, knowledgeBaseId: p.kb.id, documents: [] },
      budget: { modelCalls: 3 }, steps: [] };
    await p.service.checkpoint(started.task.id, started.token!, snapshot);
    await p.service.handoff(started.task.id, started.token!, snapshot);
    const queued = await p.store.get('tasks', started.task.id);
    expect(queued?.payload.snapshot.budget.modelCalls).toBe(3);
    expect(queued?.executionToken).toBeNull();
    await p.service.process(started.task.id);
    expect((await p.store.get('tasks', started.task.id))?.status).toBe('completed');
    expect((await p.store.list('messages')).filter(m => m.role === 'user')).toHaveLength(1);
    expect((await p.store.list('messages')).filter(m => m.role === 'assistant')).toHaveLength(1);
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
    await p.service.checkpoint(started.task.id, started.token!, {
      userId: 1, knowledgeBaseId: doc.knowledgeBaseId, question: p.input.question, chatId: started.chat.id,
      scope: { userId: 1, knowledgeBaseId: doc.knowledgeBaseId, documents: [{ documentId: doc.id, indexRevisionId: doc.activeIndexRevisionId }] },
    });
    await p.store.save('documents', { id: doc.id, activeIndexRevisionId: doc.activeIndexRevisionId + 1 });
    await expect(p.service.complete(started.task.id, started.token!, { answer: '旧版答案', citations: [] })).rejects.toThrow('索引');
    expect((await p.store.list('messages')).filter(m => m.role === 'assistant' && m.generationStatus === 'completed')).toHaveLength(0);
  } finally { await p.cleanup(); }
});

it('retains failed foreground counters on manual retry and hides credentials and internal state', async () => {
  const p = await fixture();
  try {
    const started = await p.service.begin(1, { ...p.input, apiKey: 'private-test-api-key' });
    await p.service.checkpoint(started.task.id, started.token!, {
      userId: 1, knowledgeBaseId: p.kb.id, question: p.input.question, runId: 2,
      budget: { modelCalls: 9 }, messages: ['internal prompt'], steps: [],
    });
    await p.service.fail(started.task.id, started.token!, new Error('temporary outage'));
    const retried = await p.tasks.retry(started.task.id, 1);
    expect((await p.store.get('tasks', started.task.id))?.payload.snapshot.budget.modelCalls).toBe(9);
    const serialized = JSON.stringify(retried);
    expect(serialized).not.toContain('private-test-api-key');
    expect(serialized).not.toContain('internal prompt');
  } finally { await p.cleanup(); }
});

