import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { Store, now, Row } from '../../persistence/store';
import { ApiError } from '../../common/api-error';
import { SummaryService } from '../rag/summary.service';

const ended = (s: string) => ['completed', 'failed', 'partial_failed', 'canceled'].includes(s);

@Injectable()
export class QaTasksService {
  constructor(
    private readonly store: Store,
    private readonly summary: SummaryService,
    private readonly config: ConfigService,
  ) {}
  private key() {
    return createHash('sha256')
      .update(this.config.getOrThrow<string>('JWT_SECRET') + '/qa-credential')
      .digest();
  }
  private seal(value?: string) {
    if (!value) return null;
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map((b) => b.toString('base64')).join('.');
  }
  private open(value?: string) {
    if (!value) return undefined;
    const [iv, tag, bytes] = value.split('.').map((s) => Buffer.from(s, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8');
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
        payload: { chatId, requestId, fingerprint, snapshot, credential: this.seal(apiKey) },
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
    const token = randomUUID();
    const task = await this.store.transaction(async (tx) => {
      const row = await tx.lock('tasks', id);
      if (!row || row.kind !== 'qa' || ended(row.status)) return null;
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
