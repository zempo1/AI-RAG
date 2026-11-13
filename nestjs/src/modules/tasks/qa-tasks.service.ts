/** 执行后台长文问答任务，保存结果并更新任务进度。 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Store, now, Row } from '../../persistence/store';
import { ApiError } from '../../common/api-error';
import { SummaryService } from '../rag/summary.service';
import { AgentQaTasksService } from './agent-qa.service';
import { sealQaCredential, openQaCredential } from './qa-credentials';
import { runWithTaskModels, sealRuntimeModels } from '../model-settings/model-runtime';

const ended = (s: string) => ['completed', 'failed', 'partial_failed', 'canceled'].includes(s);

@Injectable()
export class QaTasksService {
  constructor(
    private readonly store: Store,
    private readonly summary: SummaryService,
    private readonly config: ConfigService,
    @Optional() private readonly agentTasks?: AgentQaTasksService,
  ) {}
  // 后台任务需要稍后调用模型，临时凭据加密存储；加密密钥由 JWT_SECRET 派生。
  private seal(value?: string) {
    return sealQaCredential(this.config.getOrThrow('JWT_SECRET'), value);
  }
  private open(value?: string) {
    return openQaCredential(this.config.getOrThrow('JWT_SECRET'), value);
  }
  private accepted(task: Row) {
    return {
      taskId: task.id,
      chatId: task.payload.chatId,
      requestId: task.payload.requestId,
      status: task.status,
    };
  }
  async lookup(userId: number, requestId: string, fingerprint: string) {
    const key = 'qa/' + userId + '/' + requestId;
    const task = (await this.store.list('tasks', { userId, idempotencyKey: key }))[0];
    if (!task) return null;
    if (task.payload.fingerprint !== fingerprint)
      throw new ApiError(409, 'requestId 已用于不同的问题或来源');
    return this.accepted(task);
  }
  async enqueue(
    userId: number,
    chatId: number,
    requestId: string,
    fingerprint: string,
    snapshot: any,
    apiKey?: string,
    retrievalContext?: unknown,
  ) {
    const chat = await this.store.get('chats', chatId);
    if (!chat || chat.userId !== userId || chat.knowledgeBaseId !== snapshot.knowledgeBaseId)
      throw new ApiError(404, '会话不存在');
    const key = 'qa/' + userId + '/' + requestId;
    const accepted = await this.store.transaction(async (tx) => {
      // Serializes duplicate acceptance across API processes as well as the SQL unique key.
      const kb = await tx.lock('knowledgeBases', snapshot.knowledgeBaseId);
      if (!kb || kb.userId !== userId || kb.deletedAt) throw new ApiError(409, '知识库不可用');
      const existing = (await tx.list('tasks', { userId, idempotencyKey: key }))[0];
      if (existing) {
        if (existing.payload.fingerprint !== fingerprint)
          throw new ApiError(409, 'requestId 已用于不同的问题或来源');
        return existing;
      }
      const task = await tx.save('tasks', {
        userId,
        knowledgeBaseId: kb.id,
        kind: 'qa',
        documentId: null,
        indexRevisionId: null,
        parentTaskId: null,
        idempotencyKey: key,
        status: 'queued',
        stage: 'queued',
        completed: 0,
        total: null,
        attempts: 0,
        dispatchGeneration: 0,
        executionToken: null,
        retryable: 1,
        error: null,
        updatedAt: now(),
        payload: { chatId, requestId, fingerprint, snapshot, credential: this.seal(apiKey), modelSnapshot: sealRuntimeModels(this.config) },
      });
      await tx.save('messages', {
        chatId,
        role: 'user',
        content: snapshot.question,
        citations: [],
        retrievalContext: { ...(retrievalContext as any), requestId, taskId: task.id },
        generationStatus: 'completed',
      });
      return task;
    });
    return this.accepted(accepted);
  }
  async process(id: number, attempt = 1, report?: (progress: object) => Promise<void>) {
    const task = await this.store.get('tasks', id);
    if (!task) return 'done';
    return runWithTaskModels(this.config, { userId: task.userId, payload: task.payload }, () => this.processScoped(id, attempt, report));
  }

  private async processScoped(id: number, attempt: number, report?: (progress: object) => Promise<void>) {
    const current = await this.store.get('tasks', id);
    if (current?.payload?.engine === 'agentic-v1') {
      if (!this.agentTasks) throw new ApiError(503, 'Agent执行服务尚未加载');
      return this.agentTasks.process(id, attempt, report);
    }
    const token = randomUUID();
    const task = await this.store.transaction(async (tx) => {
      const row = await tx.lock('tasks', id);
      if (!row || row.kind !== 'qa' || ended(row.status)) return null;
      // 有效租约内不重复领取；租约过期后允许恢复，令牌用于阻止旧执行者提交结果。
      if (row.executionToken && row.payload?.leaseUntil > Date.now()) return null;
      return tx.save('tasks', {
        id,
        status: 'running',
        stage: 'summarizing',
        executionToken: token,
        attempts: attempt,
        updatedAt: now(),
        payload: { ...row.payload, leaseUntil: Date.now() + 300000 },
      });
    });
    if (!task)
      return (await this.store.get('tasks', id))?.status === 'running' ? 'waiting' : 'done';
    const progress = async (completed: number, total: number) => {
      await this.store.transaction(async (tx) => {
        const current = await tx.lock('tasks', id);
        if (current?.executionToken !== token) throw new Error('任务执行权已变化');
        await tx.save('tasks', {
          id,
          completed,
          total,
          updatedAt: now(),
          payload: { ...current.payload, leaseUntil: Date.now() + 300000 },
        });
      });
      await report?.({ completed, total, stage: 'summarizing' });
    };
    // 长摘要可能超过单次租约，定期续租，避免仍在执行的任务被其他 Worker 接管。
    const heartbeat = setInterval(() => {
      void this.store
        .transaction(async (tx) => {
          const row = await tx.lock('tasks', id);
          if (row?.executionToken === token)
            await tx.save('tasks', {
              id,
              payload: { ...row.payload, leaseUntil: Date.now() + 300000 },
            });
        })
        .catch(() => undefined);
    }, 30000);
    heartbeat.unref();
    try {
      const result = await this.summary.summarize(
        task.payload.snapshot,
        task.payload.snapshot.question,
        this.open(task.payload.credential),
        progress,
      );
      await this.store.transaction(async (tx) => {
        const current = await tx.lock('tasks', id);
        if (current?.executionToken !== token) return;
        const chat = await tx.get('chats', task.payload.chatId);
        if (!chat || chat.userId !== task.userId) {
          await tx.save('tasks', {
            id,
            status: 'canceled',
            stage: 'canceled',
            executionToken: null,
            payload: { ...current.payload, credential: null, snapshot: null },
          });
          return;
        }
        const message = await tx.save('messages', {
          id: current.payload.messageId,
          chatId: chat.id,
          role: 'assistant',
          content: result.answer,
          citations: result.citations,
          generationStatus: 'completed',
          retrievalRunId:
            result.diagnostics?.runId || task.payload.snapshot.diagnostics?.runId || null,
          diagnostics: { ...result.diagnostics, coverage: result.coverage },
        });
        // 部分章节失败仍保存可用答案，并标记 partial_failed，供用户识别覆盖不足和重试。
        const complete = result.coverage?.complete !== false;
        await tx.save('tasks', {
          id,
          status: complete ? 'completed' : 'partial_failed',
          stage: complete ? 'completed' : 'partial_failed',
          executionToken: null,
          error: complete ? null : '部分章节处理失败，可重试',
          updatedAt: now(),
          payload: {
            ...current.payload,
            credential: complete ? null : current.payload.credential,
            messageId: message.id,
            qaResult: {
              chatId: chat.id,
              messageId: message.id,
              retrievalRunId: message.retrievalRunId,
              coverage: result.coverage,
            },
          },
        });
      });
      return 'done';
    } catch {
      await this.store.transaction(async (tx) => {
        const current = await tx.lock('tasks', id);
        if (current?.executionToken === token)
          await tx.save('tasks', {
            id,
            status: attempt >= 3 ? 'failed' : 'retrying',
            stage: attempt >= 3 ? 'failed' : 'retrying',
            executionToken: null,
            error: '总结服务暂不可用，请稍后重试',
            updatedAt: now(),
          });
      });
      throw new Error('总结服务暂不可用，请稍后重试');
    } finally {
      clearInterval(heartbeat);
    }
  }
}
