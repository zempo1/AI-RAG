/** Durable foreground ownership and background continuation for one Agent request. */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Store, Row, now } from '../../persistence/store';
import { ApiError } from '../../common/api-error';
import { HistoryService } from '../history/history.service';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { AgentService } from '../agent/agent.service';
import { INTERRUPT } from '@langchain/langgraph-checkpoint';
import { AgentExecutionRevoked, agentThreadId } from '../agent/agent-graph-owner';
import { MysqlAgentCheckpointer } from '../agent/mysql-agent-checkpointer';
import { sealQaCredential, openQaCredential } from './qa-credentials';

export { AgentExecutionRevoked } from '../agent/agent-graph-owner';
interface AgentRequest {
  question: string;
  chatId?: number | null;
  knowledgeBaseId?: number;
  requestId: string;
  fingerprint: string;
  mode?: string;
  documentIds?: number[];
  apiKey?: string;
}
const ended = (status: string) => ['completed', 'partial_failed', 'failed', 'canceled'].includes(status);

/** Public progress is deliberately built from an allowlist, never a serialized model transcript. */
export function publicAgentProgress(snapshot: any) {
  const plan = snapshot?.plan;
  const steps = Array.isArray(snapshot?.steps) ? snapshot.steps : [];
  return {
    plan: plan && { intent: plan.intent, complexity: plan.complexity, subQuestions: plan.subQuestions || [] },
    steps: steps.slice(-100).map((s: any) => ({
      runId: s.runId, sequence: s.sequence, kind: s.kind, summary: String(s.summary || '').slice(0, 600),
      ...(s.tool ? { tool: s.tool } : {}), ...(s.evidenceCount !== undefined ? { evidenceCount: s.evidenceCount } : {}),
      ...(s.elapsedMs !== undefined ? { elapsedMs: s.elapsedMs } : {}),
      ...(Array.isArray(s.sources) ? { sources: s.sources.map((r: any) => ({ filename: r.filename, page: r.page ?? null })) } : {}),
    })),
    budget: Object.fromEntries(Object.entries(snapshot?.budget || {}).filter(([key, value]) =>
      typeof value === 'number' || typeof value === 'boolean' || (key === 'tokenMode' && typeof value === 'string'))),
    stopReason: snapshot?.stopReason ?? null,
    status: snapshot?.status ?? snapshot?.phase ?? 'running',
  };
}

@Injectable()
export class AgentQaTasksService {
  constructor(
    private readonly store: Store,
    private readonly history: HistoryService,
    private readonly libraries: KnowledgeBasesService,
    private readonly agent: AgentService,
    private readonly config: ConfigService,
  ) {}

  accepted(task: Row) {
    return { taskId: task.id, chatId: task.payload.chatId, requestId: task.payload.requestId,
      status: task.status, retrievalRunId: task.payload.retrievalRunId };
  }

  async begin(userId: number, input: AgentRequest) {
    const previous = input.chatId != null ? await this.history.writable(input.chatId, userId, input.knowledgeBaseId) : undefined;
    const kb = await this.libraries.resolve(userId, previous?.knowledgeBaseId ?? input.knowledgeBaseId);
    return this.store.transaction(async tx => {
      const owned = await tx.lock('knowledgeBases', kb.id);
      if (!owned || owned.userId !== userId || owned.deletedAt) throw new ApiError(409, '知识库不可用');
      const idempotencyKey = 'qa/' + userId + '/' + input.requestId;
      const existing = (await tx.list('tasks', { userId, idempotencyKey }))[0];
      if (existing) {
        if (existing.payload.fingerprint !== input.fingerprint) throw new ApiError(409, 'requestId 已用于不同的问题或来源');
        const chat = await tx.get('chats', existing.payload.chatId);
        if (!chat) throw new ApiError(404, '会话不存在');
        return { existing: true, task: existing, chat, token: undefined as string | undefined };
      }
      const chat = previous ? await tx.get('chats', previous.id) : await tx.save('chats', {
        title: input.question.slice(0, 30), userId, knowledgeBaseId: kb.id,
      });
      if (!chat || chat.userId !== userId || chat.knowledgeBaseId !== kb.id) throw new ApiError(404, '会话不存在');
      const messages = (await tx.list('messages', { chatId: chat.id })).sort((a, b) => a.id - b.id);
      const token = randomUUID();
      let task = await tx.save('tasks', {
        userId, knowledgeBaseId: kb.id, kind: 'qa', documentId: null, indexRevisionId: null, parentTaskId: null,
        idempotencyKey, status: 'running', stage: 'understanding', completed: 0, total: null, attempts: 1,
        dispatchGeneration: 0, executionToken: token, retryable: 1, error: null, updatedAt: now(),
        payload: { engine: 'agentic-v1', chatId: chat.id, requestId: input.requestId, fingerprint: input.fingerprint,
          foreground: true, leaseUntil: Date.now() + 300000, graphVersion: 2,
          input: { question: input.question, documentIds: input.documentIds, mode: input.mode || 'auto', history: messages },
          credential: sealQaCredential(this.config.getOrThrow('JWT_SECRET'), input.apiKey) },
      });
      task = await tx.save('tasks', { id: task.id, payload: {
        ...task.payload, graphThreadId: agentThreadId(task.id),
      } });
      await tx.save('messages', { chatId: chat.id, role: 'user', content: input.question, citations: [],
        generationStatus: 'completed', retrievalContext: { documentIds: input.documentIds, mode: input.mode || 'auto',
          requestId: input.requestId, taskId: task.id } });
      return { existing: false, task, chat: { ...chat, messages }, token };
    });
  }

  async guard(id: number, token: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const task = await this.store.get('tasks', id);
    if (!task || task.executionToken !== token || task.status !== 'running') throw new AgentExecutionRevoked();
    const kb = await this.store.get('knowledgeBases', task.knowledgeBaseId);
    const chat = await this.store.get('chats', task.payload.chatId);
    if (!kb || kb.deletedAt || kb.userId !== task.userId || !chat || chat.userId !== task.userId || chat.knowledgeBaseId !== task.knowledgeBaseId)
      throw new AgentExecutionRevoked('知识库或会话已不可用');
    signal?.throwIfAborted();
    return task;
  }

  private assertOwner(task: Row | undefined, token: string): asserts task is Row {
    if (!task || task.executionToken !== token || task.status !== 'running') throw new AgentExecutionRevoked();
  }

  private async taskChat(tx: Store, task: Row) {
    const chat = await tx.get('chats', task.payload.chatId);
    return chat?.userId === task.userId && chat?.knowledgeBaseId === task.knowledgeBaseId ? chat : undefined;
  }

  async handoff(id: number, token: string) {
    const task = await this.guard(id, token);
    const saver = new MysqlAgentCheckpointer(this.store, { taskId: id, token });
    const saved = await saver.getTuple({ configurable: { thread_id: task.payload.graphThreadId } });
    if (!saved?.pendingWrites?.some(([, channel]) => channel === INTERRUPT))
      throw new Error('Agent 暂停尚未持久化');
    return this.store.transaction(async tx => {
      await tx.lock('knowledgeBases', task.knowledgeBaseId);
      const row = await tx.lock('tasks', id);
      this.assertOwner(row, token);
      const queued = await tx.save('tasks', { id, status: 'queued', stage: 'queued', executionToken: null,
        updatedAt: now(), payload: { ...row.payload, foreground: false, leaseUntil: null } });
      return this.accepted(queued);
    });
  }

  private async releaseGraph(tx: Store, task: Row) {
    if (task.payload.graphVersion === 2) await tx.deleteAgentThread(agentThreadId(task.id));
    const { graphScope, agentBudgetLedger, agentEventSequences, agentEventSequence, input, snapshot, ...payload } = task.payload;
    return payload;
  }

  async complete(id: number, token: string, result: any) {
    const current = await this.guard(id, token);
    await this.store.transaction(async tx => {
      const kb = await tx.lock('knowledgeBases', current.knowledgeBaseId);
      if (!kb || kb.deletedAt || kb.userId !== current.userId) throw new AgentExecutionRevoked('知识库不可用');
      // All checkpoint writers hold this KB lock, so this read sees the last durable scope.
      const latest = await tx.get('tasks', id);
      this.assertOwner(latest, token);
      const scope = latest.payload.graphScope;
      for (const expected of [...(scope?.documents || [])].sort((a: any, b: any) => a.documentId - b.documentId)) {
        const doc = await tx.lock('documents', expected.documentId);
        if (!doc || doc.deletedAt || doc.userId !== current.userId || doc.knowledgeBaseId !== current.knowledgeBaseId)
          throw new AgentExecutionRevoked('来源文档已不可用');
        if (doc.activeIndexRevisionId !== expected.indexRevisionId) throw new AgentExecutionRevoked('文档索引已更新，请重新提问');
        const revision = await tx.get('indexRevisions', expected.indexRevisionId);
        if (!revision || revision.status === 'cleaned') throw new AgentExecutionRevoked('文档索引已清理，请重新提问');
      }
      const task = await tx.lock('tasks', id);
      this.assertOwner(task, token);
      const chat = await this.taskChat(tx, task);
      if (!chat) throw new AgentExecutionRevoked('会话不存在');
      const message = await tx.save('messages', { id: task.payload.messageId, chatId: chat.id, role: 'assistant',
        content: result.answer, citations: result.citations || [], generationStatus: 'completed',
        retrievalRunId: result.retrievalRunId || task.payload.retrievalRunId || null, diagnostics: result.diagnostics || null });
      const payload = await this.releaseGraph(tx, task);
      await tx.save('tasks', { id, status: 'completed', stage: 'completed', executionToken: null, retryable: 0, error: null,
        updatedAt: now(), payload: { ...payload, foreground: false, credential: null, leaseUntil: null,
          messageId: message.id, agentProgress: result.diagnostics?.agent || task.payload.agentProgress,
          qaResult: { chatId: chat.id, messageId: message.id, retrievalRunId: message.retrievalRunId,
            coverage: result.coverage || result.diagnostics?.coverage } } });
    });
  }

  async fail(id: number, token: string, error: any, attempt = 3, background = false, partial?: any) {
    const initial = await this.store.get('tasks', id);
    if (!initial) return;
    await this.store.transaction(async tx => {
      await tx.lock('knowledgeBases', initial.knowledgeBaseId);
      const task = await tx.lock('tasks', id);
      if (!task || task.executionToken !== token) return;
      if (task.status === 'canceled') {
        await tx.save('tasks', { id, executionToken: null, payload: { ...task.payload, credential: null, leaseUntil: null } });
        return;
      }
      const chat = await this.taskChat(tx, task);
      const retryable = !!chat && error?.retryable !== false && !(error instanceof AgentExecutionRevoked) &&
        !(error instanceof ApiError && error.getStatus() < 500);
      const retrying = background && retryable && attempt < 3;
      let messageId = chat ? task.payload.messageId : null;
      if (chat && !retrying) messageId = (await tx.save('messages', { id: messageId,
        chatId: chat.id, role: 'assistant', content: partial?.answer || '回答未完成，请重试。',
        citations: partial?.citations || [], generationStatus: 'interrupted', retrievalRunId: task.payload.retrievalRunId || null,
        diagnostics: partial?.diagnostics || { agent: { ...task.payload.agentProgress, status: 'interrupted' } } })).id;
      const payload = retryable ? task.payload : await this.releaseGraph(tx, task);
      await tx.save('tasks', { id, status: retrying ? 'retrying' : 'failed', stage: retrying ? 'retrying' : 'failed',
        executionToken: null, retryable: retryable ? 1 : 0, error: error instanceof AgentExecutionRevoked
          ? error.message : '问答执行未完成，可查看执行过程或稍后重试', updatedAt: now(),
        payload: { ...payload, messageId, foreground: false, leaseUntil: null,
          ...(retryable ? {} : { credential: null }) } });
    });
  }

  async cancel(id: number, userId: number, partial?: any) {
    const initial = await this.store.get('tasks', id);
    if (!initial || initial.userId !== userId || initial.kind !== 'qa' || initial.payload?.engine !== 'agentic-v1')
      throw new ApiError(404, 'Agent任务不存在');
    await this.store.transaction(async tx => {
      await tx.lock('knowledgeBases', initial.knowledgeBaseId);
      const task = await tx.lock('tasks', id);
      if (!task || task.userId !== userId || task.kind !== 'qa' || task.payload?.engine !== 'agentic-v1') throw new ApiError(404, 'Agent任务不存在');
      if (ended(task.status)) return;
      const chat = await this.taskChat(tx, task);
      const message = chat && await tx.save('messages', { id: task.payload.messageId,
        chatId: chat.id, role: 'assistant', content: partial?.answer || '回答已停止。', citations: partial?.citations || [],
        generationStatus: 'interrupted', retrievalRunId: task.payload.retrievalRunId || null,
        diagnostics: partial?.diagnostics || { agent: { ...task.payload.agentProgress, status: 'canceled', stopReason: 'canceled' } } });
      const payload = await this.releaseGraph(tx, task);
      await tx.save('tasks', { id, status: 'canceled', stage: 'canceled', executionToken: null, retryable: 0, updatedAt: now(),
        payload: { ...payload, messageId: message?.id ?? null, foreground: false, credential: null, leaseUntil: null,
          agentProgress: { ...task.payload.agentProgress, status: 'canceled', stopReason: 'canceled' } } });
    });
    return { id, status: (await this.store.get('tasks', id))?.status };
  }

  execution(id: number, token: string, external?: AbortSignal) {
    const abort = new AbortController();
    const signal = external ? AbortSignal.any([external, abort.signal]) : abort.signal;
    let checking = false, renewing = 0;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.guard(id, token, signal).then(async task => {
        if (Date.now() - renewing < 30000) return;
        renewing = Date.now();
        await this.store.transaction(async tx => {
          await tx.lock('knowledgeBases', task.knowledgeBaseId);
          const row = await tx.lock('tasks', id);
          this.assertOwner(row, token);
          await tx.save('tasks', { id, payload: { ...row.payload, leaseUntil: Date.now() + 300000 }, updatedAt: now() });
        });
      }).catch(error => abort.abort(error)).finally(() => { checking = false; });
    }, 1000);
    timer.unref();
    return { signal, guard: () => this.guard(id, token, signal), graphOwner: { taskId: id, token },
      dispose: () => clearInterval(timer) };
  }

  async process(id: number, attempt = 1, report?: (progress: object) => Promise<void>) {
    const initial = await this.store.get('tasks', id);
    if (!initial || initial.payload?.engine !== 'agentic-v1') return 'done';
    const token = randomUUID();
    const task = await this.store.transaction(async tx => {
      await tx.lock('knowledgeBases', initial.knowledgeBaseId);
      const row = await tx.lock('tasks', id);
      if (!row) return null;
      if (row.status === 'canceled' && row.executionToken && !(row.payload?.leaseUntil > Date.now()))
        await tx.save('tasks', { id, executionToken: null, payload: { ...row.payload, credential: null } });
      if (ended(row.status)) return null;
      if (row.executionToken && row.payload?.leaseUntil > Date.now()) return null;
      const { snapshot, ...payload } = row.payload;
      const importedProgress = snapshot && row.payload.graphVersion !== 2
        ? row.payload.agentProgress ?? publicAgentProgress(snapshot)
        : undefined;
      return tx.save('tasks', { id, status: 'running', stage: 'agent', executionToken: token, attempts: attempt,
        updatedAt: now(), payload: {
          ...payload, ...(snapshot ? { snapshot } : {}),
          ...(importedProgress ? { agentProgress: importedProgress,
            agentEventSequence: Math.max(0, ...importedProgress.steps.map((step: { sequence: number }) => step.sequence)) } : {}),
          graphVersion: 2, graphThreadId: agentThreadId(id), foreground: false, leaseUntil: Date.now() + 300000,
        } });
    });
    if (!task) return ended((await this.store.get('tasks', id))?.status || '') ? 'done' : 'waiting';
    const execution = this.execution(id, token);
    try {
      const key = openQaCredential(this.config.getOrThrow('JWT_SECRET'), task.payload.credential);
      const legacy = task.payload.snapshot;
      const input = task.payload.input ?? (legacy && {
        question: legacy.question, history: legacy.history, mode: legacy.mode,
      });
      if (!input?.question) throw new ApiError(409, '问答任务缺少问题内容');
      const options = { ...execution, background: true, apiKey: key,
        onAgentStep: (step: { sequence: number }) => report?.({ stage: 'agent', completed: step.sequence, total: null }) };
      const context = await this.agent.prepare(input.question, task.userId, task.knowledgeBaseId,
        { ...input, ...options, chatId: task.payload.chatId });
      const result = await this.agent.answerPrepared(context, key, execution.signal);
      await this.complete(id, token, result);
      return 'done';
    } catch (error) {
      await this.fail(id, token, error, attempt, true);
      if ((await this.store.get('tasks', id))?.status === 'canceled') return 'done';
      throw error;
    } finally { execution.dispose(); }
  }
}
