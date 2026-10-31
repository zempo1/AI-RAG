import { Injectable } from '@nestjs/common';
import { Store, Row, now } from '../../persistence/store';
import { ApiError } from '../../common/api-error';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';

export const terminalTask = (status: string) =>
  ['completed', 'failed', 'partial_failed', 'canceled'].includes(status);

@Injectable()
export class TasksService {
  constructor(
    private readonly store: Store,
    private readonly libraries: KnowledgeBasesService,
  ) {}

  private present(row: Row): Row {
    const { executionToken, idempotencyKey, ...result } = row;
    const raw = row.payload?.notBefore;
    const waitingUntil = raw ? (/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : raw + 'Z') : null;
    const delayed =
      waitingUntil && Date.parse(waitingUntil) > Date.now() && !terminalTask(row.status);
    return {
      ...result,
      canDismiss: terminalTask(row.status) && !executionToken && !row.parentTaskId,
      waitingUntil: delayed ? waitingUntil : null,
      waitingReason: delayed
        ? '等待索引保留期结束，保护已经开始的问答'
        : row.stage === 'waiting'
          ? '等待关联文档处理任务结束'
          : null,
    };
  }

  create(tx: Store, values: Partial<Row>) {
    return tx.save('tasks', {
      documentId: null,
      indexRevisionId: null,
      parentTaskId: null,
      idempotencyKey: null,
      status: 'queued',
      stage: 'queued',
      completed: 0,
      total: null,
      attempts: 0,
      dispatchGeneration: 0,
      retryable: 1,
      error: null,
      payload: null,
      executionToken: null,
      updatedAt: now(),
      ...values,
    });
  }

  async get(id: number, userId: number) {
    const task = await this.store.get('tasks', id);
    if (!task || task.userId !== userId) throw new ApiError(404, '任务不存在');
    const children =
      task.kind === 'rebuild' ? await this.store.list('tasks', { parentTaskId: id }) : undefined;
    const sanitize = (row: Row) => {
      return this.present(row);
    };
    return { ...sanitize(task), ...(children ? { children: children.map(sanitize) } : {}) } as Row;
  }

  async list(userId: number, knowledgeBaseId: number) {
    await this.libraries.owned(knowledgeBaseId, userId);
    const rows = await this.store.list('tasks', { userId, knowledgeBaseId });
    let historyCount = 0;
    return rows
      .filter((t) => !t.parentTaskId && !t.payload?.dismissedAt)
      .sort(
        (a, b) => Number(terminalTask(a.status)) - Number(terminalTask(b.status)) || b.id - a.id,
      )
      .filter(t => !terminalTask(t.status) || historyCount++ < 50)
      .map((row) => this.present(row));
  }

  async dismiss(id: number, userId: number) {
    const initial = await this.get(id, userId);
    await this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', initial.knowledgeBaseId);
      const task = await tx.lock('tasks', id);
      if (!task || task.userId !== userId) throw new ApiError(404, '任务不存在');
      if (
        !terminalTask(task.status) ||
        task.executionToken ||
        task.parentTaskId ||
        (await tx.list('tasks', { parentTaskId: id })).some(
          (t) => !terminalTask(t.status) || t.executionToken,
        )
      )
        throw new ApiError(409, '进行中的任务不能移除');
      await tx.save('tasks', { id, payload: { ...task.payload, dismissedAt: now() } });
    });
    return { removed: true };
  }

  async clearCompleted(userId: number, knowledgeBaseId: number) {
    await this.libraries.owned(knowledgeBaseId, userId);
    let removed = 0;
    for (const task of await this.store.list('tasks', { userId, knowledgeBaseId })) {
      if (
        task.parentTaskId ||
        task.executionToken ||
        task.payload?.dismissedAt ||
        !['completed', 'canceled'].includes(task.status)
      )
        continue;
      try {
        await this.dismiss(task.id, userId);
        removed++;
      } catch (error) {
        if (!(error instanceof ApiError) || error.getStatus() !== 409) throw error;
      }
    }
    return { removed };
  }

  async retry(id: number, userId: number) {
    const initial = await this.get(id, userId);
    await this.store.transaction(async (tx) => {
      const kb = await tx.lock('knowledgeBases', initial.knowledgeBaseId);
      if (!kb || kb.deletedAt) {
        if (!['cleanup', 'cleanup-library', 'retire'].includes(initial.kind))
          throw new ApiError(409, '知识库已删除');
      }
      if (initial.kind === 'rebuild') {
        if (
          kb?.rebuildTaskId ||
          (await tx.list('tasks', { knowledgeBaseId: initial.knowledgeBaseId })).some(
            (t) => t.kind === 'index' && !terminalTask(t.status),
          )
        )
          throw new ApiError(409, '知识库有进行中的任务');
        const parent = await tx.lock('tasks', id);
        if (!parent || !['failed', 'partial_failed'].includes(parent.status))
          throw new ApiError(409, '任务不可重试');
        for (const child of await tx.list('tasks', { parentTaskId: id })) {
          if (child.status !== 'failed') continue;
          const doc = await tx.lock('documents', child.documentId);
          if (!doc || doc.deletedAt || doc.desiredIndexRevisionId !== child.indexRevisionId) {
            await tx.save('tasks', { id: child.id, status: 'canceled', stage: 'canceled' });
          } else {
            await this.reset(tx, child);
          }
        }
        await tx.save('knowledgeBases', { id: initial.knowledgeBaseId, rebuildTaskId: id });
        await tx.save('tasks', {
          id,
          status: 'running',
          stage: 'rebuilding',
          error: null,
          payload: { ...parent.payload, dismissedAt: null },
          updatedAt: now(),
        });
      } else {
        const doc = initial.documentId ? await tx.lock('documents', initial.documentId) : undefined;
        const task = await tx.lock('tasks', id);
        if (!task || task.status !== 'failed' || !task.retryable)
          throw new ApiError(409, '任务不可重试');
        if (task.kind === 'index') {
          if (kb?.rebuildTaskId && kb.rebuildTaskId !== task.parentTaskId)
            throw new ApiError(409, '知识库正在重建');
          if (!doc || doc.deletedAt || doc.desiredIndexRevisionId !== task.indexRevisionId)
            throw new ApiError(409, '文档已删除或已有更新版本');
          if (task.parentTaskId) throw new ApiError(409, '请重试所属知识库重建任务');
          await tx.save('documents', { id: doc.id, status: 'queued' });
        }
        await this.reset(tx, task);
      }
    });
    if (initial.kind === 'rebuild') await this.refreshParent(id);
    return this.get(id, userId);
  }

  private reset(tx: Store, task: Row) {
    return tx.save('tasks', {
      id: task.id,
      status: 'queued',
      stage: 'queued',
      completed: 0,
      total: null,
      error: null,
      executionToken: null,
      attempts: 0,
      dispatchGeneration: task.dispatchGeneration + 1,
      updatedAt: now(),
      payload: { ...task.payload, dismissedAt: null },
    });
  }

  async refreshParent(parentId?: number | null) {
    if (!parentId) return;
    const initial = await this.store.get('tasks', parentId);
    if (!initial) return;
    await this.store.transaction(async (tx) => {
      const kb = await tx.lock('knowledgeBases', initial.knowledgeBaseId);
      const parent = await tx.lock('tasks', parentId);
      if (!parent || parent.status === 'canceled') return;
      const children = await tx.list('tasks', { parentTaskId: parentId });
      const done = children.filter((c) => terminalTask(c.status)).length;
      const failed = children.filter((c) => c.status === 'failed').length;
      const complete = done === children.length;
      const status = complete
        ? failed
          ? failed === children.length
            ? 'failed'
            : 'partial_failed'
          : 'completed'
        : 'running';
      await tx.save('tasks', {
        id: parentId,
        status,
        stage: complete ? status : 'rebuilding',
        completed: done,
        total: children.length,
        error: failed ? String(failed) + ' 份文档处理失败' : null,
        updatedAt: now(),
      });
      if (complete && kb?.rebuildTaskId === parentId)
        await tx.save('knowledgeBases', { id: kb.id, rebuildTaskId: null });
    });
  }
}
