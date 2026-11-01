import { legacyModelProfile, ModelProfile, profileFingerprint } from '../embeddings/model-profile';
import { TokenizerService } from '../embeddings/tokenizer.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, Row, now } from '../../persistence/store';
import { ApiError, errorMessage } from '../../common/api-error';
import { DocumentParser } from './parsers/document.parser';
import { ParsedDocument, paragraphBlocks } from './parsers/parsed-document';
import { RecursiveChunker } from './chunkers/recursive.chunker';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { VectorStore, Segment } from '../vector-store/vector-store.interface';
import { embeddingFingerprint } from '../vector-store/qdrant-vector-store.service';
import { TasksService, terminalTask } from '../tasks/tasks.service';

class Superseded extends Error {}
class DependencyPending extends Error {}
const wallTime = (value: string) => Date.parse(value.replace(' ', 'T') + 'Z');

@Injectable()
export class IndexingService {
  constructor(
    private readonly store: Store,
    private readonly parser: DocumentParser,
    private readonly chunker: RecursiveChunker,
    private readonly embeddings: EmbeddingsService,
    private readonly vectors: VectorStore,
    private readonly tasks: TasksService,
    private readonly config: ConfigService,
  ) {}

  async process(id: number, attempt = 1, report?: (progress: object) => Promise<void>) {
    let task = await this.store.get('tasks', id);
    if (!task || task.kind === 'rebuild') return;
    if (terminalTask(task.status)) {
      // A stalled job can be delivered again after its document was canceled.
      if (task.status === 'canceled') {
        await this.store.save('tasks', { id, executionToken: null });
        await this.ensureDeletedCleanup(task);
      }
      await this.tasks.refreshParent(task.parentTaskId);
      return;
    }
    const token = randomUUID();
    try {
      await this.store.transaction(async (tx) => {
        await tx.lock('knowledgeBases', task!.knowledgeBaseId);
        if (task!.documentId) await tx.lock('documents', task!.documentId);
        task = await tx.lock('tasks', id);
        if (!task || terminalTask(task.status)) throw new Superseded();
        if (task.kind === 'index') await this.guard(task, undefined, tx);
        task = await tx.save('tasks', {
          id,
          executionToken: token,
          status: 'running',
          attempts: attempt,
          updatedAt: now(),
          error: null,
        });
      });
      if (task!.kind === 'index') await this.index(task!, token, report);
      else await this.cleanup(task!, token);
    } catch (error) {
      if (error instanceof DependencyPending) {
        await this.store.transaction(async (tx) => {
          const current = await tx.lock('tasks', id);
          if (current?.executionToken === token && !terminalTask(current.status))
            await tx.save('tasks', {
              id,
              status: 'queued',
              stage: 'waiting',
              executionToken: null,
              updatedAt: now(),
            });
        });
        return 'waiting' as const;
      }
      const canceled = error instanceof Superseded;
      const fatal = error instanceof ApiError && error.getStatus() < 500;
      await this.store.transaction(async (tx) => {
        await tx.lock('knowledgeBases', task!.knowledgeBaseId);
        const doc = task!.documentId ? await tx.lock('documents', task!.documentId) : undefined;
        const current = await tx.lock('tasks', id);
        if (!current || current.executionToken !== token || current.status === 'completed') return;
        if (current.status === 'canceled' || canceled) {
          await tx.save('tasks', {
            id,
            status: 'canceled',
            stage: 'canceled',
            executionToken: null,
            updatedAt: now(),
          });
        } else {
          const status = fatal || attempt >= 3 ? 'failed' : 'retrying';
          await tx.save('tasks', {
            id,
            status,
            stage: status,
            error: errorMessage(error).slice(0, 2000),
            retryable: fatal ? 0 : 1,
            executionToken: null,
            updatedAt: now(),
          });
          if (
            task!.kind === 'index' &&
            doc &&
            !doc.deletedAt &&
            doc.desiredIndexRevisionId === task!.indexRevisionId
          )
            await tx.save('documents', {
              id: doc.id,
              status: status === 'failed' ? 'failed' : 'queued',
            });
        }
      });
      if (!canceled && (await this.store.get('tasks', id))?.status !== 'canceled') throw error;
    } finally {
      if (task) {
        await this.store.transaction(async (tx) => {
          const current = await tx.lock('tasks', id);
          if (current?.executionToken === token)
            await tx.save('tasks', { id, executionToken: null, updatedAt: now() });
        });
        if (task.kind === 'index') await this.ensureDeletedCleanup(task);
        await this.tasks.refreshParent(task.parentTaskId);
      }
    }
  }

  private async guard(task: Row, token?: string, tx = this.store) {
    const doc = await tx.get('documents', task.documentId);
    const kb = await tx.get('knowledgeBases', task.knowledgeBaseId);
    const current = await tx.get('tasks', task.id);
    if (
      !doc ||
      doc.deletedAt ||
      !kb ||
      kb.deletedAt ||
      doc.desiredIndexRevisionId !== task.indexRevisionId ||
      !current ||
      current.status === 'canceled' ||
      (token && current.executionToken !== token)
    )
      throw new Superseded();
    return doc;
  }

  private async progress(
    task: Row,
    token: string,
    stage: string,
    completed: number,
    total: number | null,
    report?: (progress: object) => Promise<void>,
  ) {
    await this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', task.knowledgeBaseId);
      await tx.lock('documents', task.documentId);
      await tx.lock('tasks', task.id);
      await this.guard(task, token, tx);
      await tx.save('tasks', { id: task.id, stage, completed, total, updatedAt: now() });
    });
    await report?.({ stage, completed, total });
  }

  private async index(task: Row, token: string, report?: (progress: object) => Promise<void>) {
    const revision = (await this.store.get('indexRevisions', task.indexRevisionId))!;
    if (!revision) throw new ApiError(409, '索引版本不存在');
    const profile = (revision.modelProfile || legacyModelProfile(this.config)) as ModelProfile;
    if (revision.embeddingFingerprint !== profileFingerprint(profile))
      throw new ApiError(409, '索引模型配置不匹配');
    const version = (await this.store.get('versions', revision.versionId))!;
    if (!version) throw new ApiError(400, '文档版本不存在');
    await this.store.save('indexRevisions', { id: revision.id, status: 'building' });
    await this.progress(task, token, 'parsing', 0, null, report);
    let parsed: ParsedDocument;
    if (version.originalPath) {
      if (basename(version.originalPath) !== version.originalPath)
        throw new ApiError(400, '原件路径无效');
      const bytes = await readFile(
        join(this.config.getOrThrow('ORIGINALS_DIR'), version.originalPath),
      );
      parsed = await this.parser.parseStructured(bytes, version.filename, (done, total) =>
        this.progress(task, token, 'parsing', done, total, report),
      );
    } else {
      if (!version.content?.trim()) throw new ApiError(400, '历史文档无正文，请重新上传');
      parsed = {
        text: version.content,
        blocks: paragraphBlocks(version.content, null).map((b) => ({
          ...b,
          location: { ...b.location, page: null },
        })),
      };
      await this.progress(task, token, 'parsing', 1, 1, report);
    }
    const blocks = revision.modelProfile
      ? await this.chunker.splitTokenStructured(parsed, new TokenizerService(this.config), profile)
      : this.chunker.splitStructured(parsed);
    if (!blocks.length) throw new ApiError(400, '文档未提取到有效片段');
    await this.progress(task, token, 'chunking', 0, blocks.length, report);
    const segments = await this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', task.knowledgeBaseId);
      await tx.lock('documents', task.documentId);
      await tx.lock('tasks', task.id);
      const doc = await this.guard(task, token, tx);
      await tx.save('versions', { id: version.id, content: parsed.text });
      const existing = new Map(
        (await tx.list('chunks', { indexRevisionId: revision.id })).map((c) => [c.chunkIndex, c]),
      );
      const segments: Segment[] = [];
      for (let i = 0; i < blocks.length; i++) {
        const chunk = await tx.save('chunks', {
          id: existing.get(i)?.id,
          documentId: doc.id,
          versionId: version.id,
          indexRevisionId: revision.id,
          chunkIndex: i,
          ...blocks[i],
        });
        segments.push({
          userId: doc.userId,
          knowledgeBaseId: doc.knowledgeBaseId,
          documentId: doc.id,
          versionId: version.id,
          indexRevisionId: revision.id,
          chunkId: chunk.id,
          chunkIndex: i,
          filename: doc.filename,
          ...blocks[i],
        });
      }
      return segments;
    });
    for (let offset = 0; offset < segments.length; offset += 16) {
      await this.progress(task, token, 'embedding', offset, segments.length, report);
      const batch = segments.slice(offset, offset + 16);
      const vectors = await this.embeddings.embedDocuments(
        batch.map((s) => s.text),
        profile,
      );
      if (
        vectors.length !== batch.length ||
        vectors.some((v) => !v.length || !v.every(Number.isFinite) || !v.some((x) => x !== 0))
      )
        throw new Error('Invalid embedding response');
      await this.guard(task, token);
      await this.vectors.addAll(vectors, batch, profile);
      await this.progress(task, token, 'indexing', offset + batch.length, segments.length, report);
      if (offset + batch.length === segments.length) {
        const check = await this.vectors.search(vectors[0], 1, 0, {
          userId: task.userId,
          knowledgeBaseId: task.knowledgeBaseId,
          indexRevisionIds: [revision.id],
          modelProfile: profile,
        });
        if (!check.length) throw new Error('向量写入后无法查询，尚未发布索引');
      }
    }
    await this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', task.knowledgeBaseId);
      await tx.lock('documents', task.documentId);
      await tx.lock('tasks', task.id);
      const doc = await this.guard(task, token, tx);
      if (doc.activeIndexRevisionId && doc.activeIndexRevisionId !== revision.id) {
        await tx.save('indexRevisions', {
          id: doc.activeIndexRevisionId,
          status: 'retired',
          retiredAt: now(),
        });
        await this.tasks.create(tx, {
          userId: doc.userId,
          knowledgeBaseId: doc.knowledgeBaseId,
          documentId: doc.id,
          indexRevisionId: doc.activeIndexRevisionId,
          kind: 'retire',
          payload: {
            notBefore: new Date(
              wallTime(now()) + this.config.getOrThrow<number>('INDEX_RETENTION_MS'),
            )
              .toISOString()
              .slice(0, 23),
          },
        });
      }
      await tx.save('documents', {
        id: doc.id,
        activeIndexRevisionId: revision.id,
        activeVersionId: version.id,
        status: 'ready',
        content: parsed.text,
        ...(doc.activeVersionId !== version.id ? { filename: version.filename } : {}),
      });
      await tx.save('indexRevisions', { id: revision.id, status: 'published' });
      await tx.save('tasks', {
        id: task.id,
        status: 'completed',
        stage: 'completed',
        completed: segments.length,
        total: segments.length,
        executionToken: null,
        updatedAt: now(),
      });
    });
  }

  private async cleanup(task: Row, token: string) {
    if (task.payload?.notBefore && wallTime(task.payload.notBefore) > wallTime(now()))
      throw new DependencyPending('索引仍在请求快照保留窗口');
    if (task.kind === 'retire') {
      if (task.payload?.notBefore && wallTime(task.payload.notBefore) > wallTime(now()))
        throw new DependencyPending('旧版索引仍在保留窗口');
      const doc = await this.store.get('documents', task.documentId);
      if (
        doc?.activeIndexRevisionId === task.indexRevisionId ||
        doc?.desiredIndexRevisionId === task.indexRevisionId
      )
        throw new ApiError(409, '不能清理生效或待发布的索引');
      if (
        (await this.store.list('tasks', { indexRevisionId: task.indexRevisionId })).some(
          (t) => t.kind === 'index' && t.executionToken,
        )
      )
        throw new DependencyPending('等待索引写入任务终止');
      await this.vectors.removeRevision(task.indexRevisionId, task.userId);
      for (const chunk of await this.store.list('chunks', {
        indexRevisionId: task.indexRevisionId,
      }))
        await this.store.delete('chunks', chunk.id);
      await this.store.save('indexRevisions', { id: task.indexRevisionId, status: 'cleaned' });
    } else if (task.kind === 'cleanup') {
      const doc = await this.store.get('documents', task.documentId);
      if (!doc?.deletedAt) throw new ApiError(409, '文档未删除，拒绝清理');
      const active = (await this.store.list('tasks', { documentId: task.documentId })).some(
        (t) => t.kind === 'index' && t.executionToken,
      );
      if (active) throw new DependencyPending('等待文档处理任务终止后清理');
      await this.vectors.removeDocument(task.documentId, task.userId);
      for (const version of await this.store.list('versions', { documentId: task.documentId })) {
        if (version.originalPath) {
          if (basename(version.originalPath) !== version.originalPath)
            throw new ApiError(400, '原件路径无效');
          await unlink(join(this.config.getOrThrow('ORIGINALS_DIR'), version.originalPath)).catch(
            (error) => {
              if (error.code !== 'ENOENT') throw error;
            },
          );
        }
        await this.store.delete('versions', version.id);
      }
      for (const chunk of await this.store.list('chunks', { documentId: task.documentId }))
        await this.store.delete('chunks', chunk.id);
      for (const revision of await this.store.list('indexRevisions', {
        documentId: task.documentId,
      }))
        await this.store.delete('indexRevisions', revision.id);
      await this.store.save('documents', {
        id: task.documentId,
        content: '',
        activeVersionId: null,
        status: 'deleted',
      });
    } else if (task.kind === 'cleanup-library') {
      const docs = await this.store.list('documents', { knowledgeBaseId: task.knowledgeBaseId });
      if (docs.some((d) => d.status !== 'deleted'))
        throw new DependencyPending('等待知识库文档清理完成');
      for (const category of await this.store.list('categories', {
        knowledgeBaseId: task.knowledgeBaseId,
      }))
        await this.store.delete('categories', category.id);
    }
    await this.store.transaction(async (tx) => {
      const current = await tx.lock('tasks', task.id);
      if (current?.executionToken !== token) return;
      await tx.save('tasks', {
        id: task.id,
        status: 'completed',
        stage: 'completed',
        completed: 1,
        total: 1,
        executionToken: null,
        updatedAt: now(),
      });
    });
  }

  private async ensureDeletedCleanup(task: Row) {
    const doc = await this.store.get('documents', task.documentId);
    if (!doc?.deletedAt) {
      // Superseded staging revisions never become visible and can be removed immediately.
      const current = await this.store.get('tasks', task.id);
      if (
        current?.status === 'canceled' &&
        task.indexRevisionId &&
        doc?.activeIndexRevisionId !== task.indexRevisionId &&
        doc?.desiredIndexRevisionId !== task.indexRevisionId
      ) {
        await this.store.transaction(async (tx) => {
          await tx.lock('knowledgeBases', task.knowledgeBaseId);
          await tx.lock('documents', task.documentId);
          if (
            !(await tx.list('tasks', { indexRevisionId: task.indexRevisionId })).some(
              (t) => t.kind === 'retire' && !terminalTask(t.status),
            )
          )
            await this.tasks.create(tx, {
              userId: task.userId,
              knowledgeBaseId: task.knowledgeBaseId,
              documentId: task.documentId,
              indexRevisionId: task.indexRevisionId,
              kind: 'retire',
            });
        });
      }
      return;
    }
    await this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', task.knowledgeBaseId);
      await tx.lock('documents', task.documentId);
      const tasks = await tx.list('tasks', { documentId: task.documentId });
      const existing = tasks.find((t) => t.kind === 'cleanup' && !terminalTask(t.status));
      if (!existing) {
        const cleanup = await this.tasks.create(tx, {
          userId: task.userId,
          knowledgeBaseId: task.knowledgeBaseId,
          documentId: task.documentId,
          kind: 'cleanup',
        });
        await tx.save('documents', {
          id: task.documentId,
          status: 'deleting',
          latestTaskId: cleanup.id,
        });
      }
    });
  }
}
