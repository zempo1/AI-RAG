import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, Row, now } from '../../persistence/store';
import { DocumentParser } from './parsers/document.parser';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { TasksService, terminalTask } from '../tasks/tasks.service';
import { embeddingFingerprint } from '../vector-store/qdrant-vector-store.service';
import { ApiError } from '../../common/api-error';

export interface IngestOptions {
  knowledgeBaseId?: number;
  categoryId?: number | null;
  documentId?: number;
  idempotencyKey?: string;
}
export interface AcceptedDocument {
  documentId: number;
  taskId: number;
  knowledgeBaseId: number;
  filename: string;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly store: Store,
    private readonly parser: DocumentParser,
    private readonly libraries: KnowledgeBasesService,
    private readonly tasks: TasksService,
    private readonly config: ConfigService,
  ) {}

  async owned(id: number, userId: number, tx = this.store): Promise<Row> {
    const doc = await tx.get('documents', id);
    if (!doc || doc.userId !== userId || doc.deletedAt)
      throw new ApiError(404, 'Document not found: ' + id);
    if (doc.knowledgeBaseId) await this.libraries.owned(doc.knowledgeBaseId, userId, tx);
    return doc;
  }

  async ingest(
    bytes: Buffer,
    filename: string,
    userId: number,
    options: IngestOptions = {},
  ): Promise<AcceptedDocument> {
    this.parser.validateFilename(filename);
    if (!bytes.length) throw new ApiError(400, '文件不能为空');
    if (bytes.length > this.config.getOrThrow<number>('MAX_DOCUMENT_BYTES'))
      throw new ApiError(413, '文件超过文档解析大小限制');
    const target = options.documentId ? await this.owned(options.documentId, userId) : null;
    const kb = await this.libraries.resolve(
      userId,
      options.knowledgeBaseId ?? target?.knowledgeBaseId,
    );
    if (target && target.knowledgeBaseId !== kb.id)
      throw new ApiError(400, '替换文档不属于该知识库');
    const root = this.config.getOrThrow<string>('ORIGINALS_DIR');
    await mkdir(root, { recursive: true });
    const originalPath = randomUUID() + (filename.toLowerCase().endsWith('.pdf') ? '.pdf' : '.md');
    await writeFile(join(root, originalPath), bytes, { flag: 'wx' });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let used = false;
    try {
      return await this.store.transaction(async (tx) => {
        await this.libraries.writable(tx, kb.id, userId);
        const key = options.idempotencyKey
          ? createHash('sha256')
              .update([userId, kb.id, options.documentId || 0, options.idempotencyKey].join('/'))
              .digest('hex')
          : null;
        if (key) {
          const previous = (await tx.list('tasks', { idempotencyKey: key }))[0];
          if (previous && !(await tx.get('documents', previous.documentId))?.deletedAt) {
            const revision = await tx.get('indexRevisions', previous.indexRevisionId);
            const version = revision && (await tx.get('versions', revision.versionId));
            if (version?.sha256 !== sha256 || version?.filename !== filename)
              throw new ApiError(409, '重复上传标识对应的文件内容不一致');
            const doc = await this.owned(previous.documentId, userId, tx);
            return this.accepted(doc, previous.id);
          }
          if (previous) await tx.save('tasks', { id: previous.id, idempotencyKey: null });
        }
        if (options.categoryId != null)
          await this.libraries.category(kb.id, options.categoryId, userId, tx);
        let doc = target ? await tx.lock('documents', target.id) : undefined;
        if (target) {
          await this.owned(target.id, userId, tx);
          if (doc!.knowledgeBaseId !== kb.id) throw new ApiError(400, '文档知识库不匹配');
        }
        if (!doc)
          doc = await tx.save('documents', {
            userId,
            knowledgeBaseId: kb.id,
            categoryId: options.categoryId ?? null,
            filename,
            content: '',
            activeIndexRevisionId: null,
            desiredIndexRevisionId: null,
            activeVersionId: null,
            latestTaskId: null,
            status: 'queued',
            deletedAt: null,
          });
        const version = await tx.save('versions', {
          documentId: doc.id,
          filename,
          originalPath,
          sha256,
          content: null,
          isLegacy: 0,
        });
        const task = await this.newIndex(tx, doc, version.id, null, key);
        used = true;
        return this.accepted(doc, task.id);
      });
    } finally {
      if (!used) await unlink(join(root, originalPath)).catch(() => undefined);
    }
  }

  async uploadScope(userId: number, knowledgeBaseId?: number, documentId?: number) {
    const target = documentId ? await this.owned(documentId, userId) : undefined;
    const kb = await this.libraries.resolve(userId, knowledgeBaseId ?? target?.knowledgeBaseId);
    if (target && target.knowledgeBaseId !== kb.id) throw new ApiError(400, '文档不属于该知识库');
    if (kb.rebuildTaskId) throw new ApiError(409, '知识库正在重建');
    return kb.id as number;
  }

  async submission(
    userId: number,
    knowledgeBaseId: number,
    documentId: number | undefined,
    key: string,
  ) {
    const hash = createHash('sha256')
      .update([userId, knowledgeBaseId, documentId || 0, key].join('/'))
      .digest('hex');
    const task = (await this.store.list('tasks', { idempotencyKey: hash }))[0];
    if (!task) return null;
    const doc = await this.store.get('documents', task.documentId);
    if (!doc || doc.deletedAt || doc.userId !== userId || doc.knowledgeBaseId !== knowledgeBaseId)
      return null;
    return this.accepted(doc, task.id);
  }

  private accepted(doc: Row, taskId: number): AcceptedDocument {
    return {
      documentId: doc.id,
      taskId,
      knowledgeBaseId: doc.knowledgeBaseId,
      filename: doc.filename,
    };
  }

  private async newIndex(
    tx: Store,
    doc: Row,
    versionId: number,
    parentTaskId: number | null = null,
    idempotencyKey: string | null = null,
  ) {
    const revision = await tx.save('indexRevisions', {
      documentId: doc.id,
      versionId,
      embeddingFingerprint: embeddingFingerprint(this.config),
      status: 'pending',
      retiredAt: null,
    });
    const task = await this.tasks.create(tx, {
      userId: doc.userId,
      knowledgeBaseId: doc.knowledgeBaseId,
      documentId: doc.id,
      indexRevisionId: revision.id,
      parentTaskId,
      kind: 'index',
      idempotencyKey,
    });
    for (const previous of await tx.list('tasks', { documentId: doc.id })) {
      if (previous.id !== task.id && previous.kind === 'index' && !terminalTask(previous.status))
        await tx.save('tasks', {
          id: previous.id,
          status: 'canceled',
          stage: 'superseded',
          updatedAt: now(),
        });
    }
    await tx.save('documents', {
      id: doc.id,
      desiredIndexRevisionId: revision.id,
      latestTaskId: task.id,
      status: 'queued',
    });
    return task;
  }

  async latest(userId: number): Promise<Row> {
    const docs = (await this.store.list('documents', { userId })).filter(
      (d) => !d.deletedAt && d.content,
    );
    docs.sort((a, b) => b.id - a.id);
    for (const doc of docs) {
      try {
        return await this.owned(doc.id, userId);
      } catch {
        /* deleted library */
      }
    }
    throw new ApiError(409, '尚无可用文档，请先上传并等待处理完成');
  }

  async ready(id: number, userId: number) {
    const doc = await this.owned(id, userId);
    if (!doc.content || !doc.activeVersionId) throw new ApiError(409, '文档尚未处理完成');
    return doc;
  }

  async list(userId: number, knowledgeBaseId?: number) {
    const kb = await this.libraries.resolve(userId, knowledgeBaseId);
    return (await this.store.list('documents', { userId, knowledgeBaseId: kb.id }))
      .filter((d) => !d.deletedAt)
      .sort((a, b) => b.id - a.id)
      .map(({ content, userId: owner, ...doc }) => doc);
  }

  async page(
    kbId: number,
    userId: number,
    query: {
      page?: number;
      pageSize?: number;
      name?: string;
      status?: string;
      categoryId?: number;
    },
  ) {
    let docs = await this.list(userId, kbId);
    if (query.name)
      docs = docs.filter((d) => d.filename.toLowerCase().includes(query.name!.toLowerCase()));
    if (query.status) docs = docs.filter((d) => d.status === query.status);
    if (query.categoryId != null)
      docs = docs.filter((d) => (d.categoryId || 0) === query.categoryId);
    const page = query.page || 1,
      pageSize = query.pageSize || 20;
    const items = await Promise.all(
      docs.slice((page - 1) * pageSize, page * pageSize).map(async (d) => ({
        ...d,
        task: d.latestTaskId ? await this.tasks.get(d.latestTaskId, userId) : null,
      })),
    );
    return { items, total: docs.length, page, pageSize };
  }

  async update(
    id: number,
    userId: number,
    values: { filename?: string; categoryId?: number | null },
  ) {
    const initial = await this.owned(id, userId);
    return this.store.transaction(async (tx) => {
      await this.libraries.writable(tx, initial.knowledgeBaseId, userId);
      await tx.lock('documents', id);
      await this.owned(id, userId, tx);
      if (values.categoryId != null)
        await this.libraries.category(initial.knowledgeBaseId, values.categoryId, userId, tx);
      if (values.filename !== undefined) this.parser.validateFilename(values.filename);
      await tx.save('documents', { id, ...values });
      const { content, ...row } = (await tx.get('documents', id))!;
      return row;
    });
  }

  async activate(id: number, userId: number) {
    const doc = await this.owned(id, userId);
    if (doc.activeIndexRevisionId)
      return { documentId: id, status: 'ready', taskId: doc.latestTaskId };
    if (doc.latestTaskId) {
      const task = await this.tasks.get(doc.latestTaskId, userId);
      if (!terminalTask(task.status))
        return { documentId: id, status: task.status, taskId: task.id };
      if (task.status === 'failed') return { documentId: id, status: 'failed', taskId: task.id };
    }
    return this.reindex(id, userId);
  }

  private async legacyVersion(tx: Store, doc: Row) {
    if (doc.activeVersionId) return doc.activeVersionId;
    const existing = (await tx.list('versions', { documentId: doc.id }))[0];
    const version =
      existing ||
      (await tx.save('versions', {
        documentId: doc.id,
        filename: doc.filename,
        originalPath: null,
        sha256: null,
        content: doc.content,
        isLegacy: 1,
      }));
    await tx.save('documents', { id: doc.id, activeVersionId: version.id });
    return version.id;
  }

  async reindex(id: number, userId: number) {
    let initial = await this.owned(id, userId);
    const kb = await this.libraries.resolve(userId, initial.knowledgeBaseId);
    return this.store.transaction(async (tx) => {
      await this.libraries.writable(tx, kb.id, userId);
      let doc = (await tx.lock('documents', id))!;
      await this.owned(id, userId, tx);
      if (!doc.knowledgeBaseId) doc = await tx.save('documents', { id, knowledgeBaseId: kb.id });
      const existing = (await tx.list('tasks', { documentId: id })).find(
        (t) => t.kind === 'index' && !terminalTask(t.status),
      );
      if (existing) return this.accepted(doc, existing.id);
      const versionId = await this.legacyVersion(tx, doc);
      return this.accepted(doc, (await this.newIndex(tx, doc, versionId)).id);
    });
  }

  async reindexLibrary(kbId: number, userId: number) {
    const result = await this.store.transaction(async (tx) => {
      await this.libraries.writable(tx, kbId, userId);
      if (
        (await tx.list('tasks', { knowledgeBaseId: kbId })).some(
          (t) => t.kind === 'index' && !terminalTask(t.status),
        )
      )
        throw new ApiError(409, '知识库有进行中的文档任务');
      const parent = await this.tasks.create(tx, {
        userId,
        knowledgeBaseId: kbId,
        kind: 'rebuild',
        status: 'running',
        stage: 'rebuilding',
      });
      await tx.save('knowledgeBases', { id: kbId, rebuildTaskId: parent.id });
      const docs = (await tx.list('documents', { knowledgeBaseId: kbId, userId })).filter(
        (d) => !d.deletedAt,
      );
      for (const doc of docs) {
        await tx.lock('documents', doc.id);
        const version = await this.legacyVersion(tx, doc);
        await this.newIndex(tx, doc, version, parent.id);
      }
      return { taskId: parent.id };
    });
    await this.tasks.refreshParent(result.taskId);
    return result;
  }

  async delete(id: number, userId: number) {
    const initial = await this.owned(id, userId);
    const result = await this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', initial.knowledgeBaseId);
      const doc = await tx.lock('documents', id);
      await this.owned(id, userId, tx);
      return this.tombstone(tx, doc!);
    });
    for (const task of await this.store.list('tasks', { documentId: id }))
      await this.tasks.refreshParent(task.parentTaskId);
    return result;
  }

  private async tombstone(tx: Store, doc: Row) {
    for (const task of await tx.list('tasks', { documentId: doc.id })) {
      if (task.kind === 'index' && !terminalTask(task.status))
        await tx.save('tasks', {
          id: task.id,
          status: 'canceled',
          stage: 'canceled',
          updatedAt: now(),
        });
    }
    for (const table of ['analyses', 'mindmaps'] as const)
      for (const row of await tx.list(table, { documentId: doc.id }))
        await tx.delete(table, row.id);
    const task = await this.tasks.create(tx, {
      userId: doc.userId,
      knowledgeBaseId: doc.knowledgeBaseId,
      documentId: doc.id,
      kind: 'cleanup',
      payload: {
        notBefore: new Date(
          Date.parse(now() + 'Z') + this.config.getOrThrow<number>('INDEX_RETENTION_MS'),
        )
          .toISOString()
          .slice(0, 23),
      },
    });
    await tx.save('documents', {
      id: doc.id,
      deletedAt: now(),
      activeIndexRevisionId: null,
      desiredIndexRevisionId: null,
      status: 'deleting',
      latestTaskId: task.id,
    });
    return { documentId: doc.id, taskId: task.id };
  }

  async deleteLibrary(kbId: number, userId: number) {
    return this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', kbId);
      const kb = await this.libraries.owned(kbId, userId, tx);
      if (kb.rebuildTaskId)
        await tx.save('tasks', {
          id: kb.rebuildTaskId,
          status: 'canceled',
          stage: 'canceled',
          updatedAt: now(),
        });
      for (const doc of await tx.list('documents', { knowledgeBaseId: kbId, userId })) {
        await tx.lock('documents', doc.id);
        if (!doc.deletedAt) await this.tombstone(tx, doc);
      }
      await tx.save('knowledgeBases', {
        id: kbId,
        deletedAt: now(),
        isDefault: null,
        rebuildTaskId: null,
      });
      const task = await this.tasks.create(tx, {
        userId,
        knowledgeBaseId: kbId,
        kind: 'cleanup-library',
      });
      return { taskId: task.id };
    });
  }
}
