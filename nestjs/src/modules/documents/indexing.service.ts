/** 执行解析、分块、向量化、索引发布及旧版本清理任务。 */
import {
  assertTokenizerProfile,
  legacyModelProfile,
  ModelProfile,
  profileFingerprint,
} from '../embeddings/model-profile';
import { TokenizerService } from '../embeddings/tokenizer.service';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store, Row, now } from '../../persistence/store';
import { ApiError, errorMessage } from '../../common/api-error';
import { DocumentParser } from './parsers/document.parser';
import { ParsedBlock, ParsedDocument, paragraphBlocks } from './parsers/parsed-document';
import type { ParseContext } from './parsers/pdf-visual.service';
import { RecursiveChunker } from './chunkers/recursive.chunker';
import {
  EmbeddingsService,
  REMOTE_EMBEDDING_BATCH_SIZE,
  REMOTE_EMBEDDING_CONCURRENCY,
} from '../embeddings/embeddings.service';
import { VectorStore, Segment } from '../vector-store/vector-store.interface';
import { TasksService, terminalTask } from '../tasks/tasks.service';
import { PageAssetsService } from './page-assets.service';

class Superseded extends Error {}
class DependencyPending extends Error {}
const wallTime = (value: string) => Date.parse(value.replace(' ', 'T') + 'Z');
type IndexBlock = ParsedBlock & { retrievalMetadata?: Record<string, unknown> };
type Count = { completed: number; total: number | null };
type IndexProgress = Record<'pages' | 'regions' | 'embedding' | 'indexing', Count>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class IndexingService {
  private readonly logger = new Logger(IndexingService.name);

  constructor(
    private readonly store: Store,
    private readonly parser: DocumentParser,
    private readonly chunker: RecursiveChunker,
    private readonly embeddings: EmbeddingsService,
    private readonly vectors: VectorStore,
    private readonly tasks: TasksService,
    private readonly config: ConfigService,
    @Optional() private readonly assets?: PageAssetsService,
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
    // 每次执行领取独立令牌；后续写状态前核对令牌，防止旧 Worker 覆盖新执行结果。
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
      // 参数或文档本身的问题无需自动重试；临时故障最多尝试三次。
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

  // 统一检查文档是否删除、目标版本是否变更、任务是否取消；耗时步骤之间也要检查。
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
    indexProgress?: IndexProgress,
  ) {
    await this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', task.knowledgeBaseId);
      await tx.lock('documents', task.documentId);
      await tx.lock('tasks', task.id);
      await this.guard(task, token, tx);
      const current = await tx.get('tasks', task.id);
      await tx.save('tasks', {
        id: task.id,
        stage,
        completed,
        total,
        updatedAt: now(),
        ...(indexProgress ? { payload: { ...current?.payload, indexProgress } } : {}),
      });
    });
    await report?.({ stage, completed, total, ...(indexProgress ? { indexProgress } : {}) });
  }

  private async index(task: Row, token: string, report?: (progress: object) => Promise<void>) {
    const revision = (await this.store.get('indexRevisions', task.indexRevisionId))!;
    if (!revision) throw new ApiError(409, '索引版本不存在');
    const profile = (revision.modelProfile || legacyModelProfile(this.config)) as ModelProfile;
    if (revision.embeddingFingerprint !== profileFingerprint(profile))
      throw new ApiError(409, '索引模型配置不匹配');
    const version = (await this.store.get('versions', revision.versionId))!;
    if (!version) throw new ApiError(400, '文档版本不存在');
    assertTokenizerProfile(profile);
    const started = Date.now();
    const content = await this.buildRevision(task, token, version, revision, profile, report);
    await this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', task.knowledgeBaseId);
      await tx.lock('documents', task.documentId);
      await tx.lock('tasks', task.id);
      const doc = await this.guard(task, token, tx);
      // 新版本可查询后才切换生效指针；旧版本延迟清理，为已经开始的问答保留证据。
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
      await tx.save('versions', { id: version.id, content: content.text });
      await tx.save('documents', {
        id: doc.id,
        activeIndexRevisionId: revision.id,
        activeVersionId: version.id,
        status: 'ready',
        content: content.text,
        ...(doc.activeVersionId !== version.id ? { filename: version.filename } : {}),
      });
      await tx.save('indexRevisions', { id: revision.id, status: 'published' });
      await tx.save('tasks', {
        id: task.id,
        status: 'completed',
        stage: 'completed',
        completed: content.count,
        total: content.count,
        executionToken: null,
        updatedAt: now(),
      });
    });
    if (content.metrics)
      this.logger.log(
        JSON.stringify({
          event: 'pdf-index-published',
          elapsedMs: Date.now() - started,
          chunks: content.count,
          ...content.metrics,
        }),
      );
  }

  private withExecution<T>(task: Row, token: string, work: (tx: Store, doc: Row) => Promise<T>) {
    return this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', task.knowledgeBaseId);
      await tx.lock('documents', task.documentId);
      await tx.lock('tasks', task.id);
      const doc = await this.guard(task, token, tx);
      return work(tx, doc);
    });
  }

  private withVectorExecution<T>(task: Row, token: string, work: () => Promise<T>) {
    return this.store.withDocumentVectorLock(task.documentId, async (store) => {
      await this.guard(task, token, store);
      return work();
    });
  }

  private async buildRevision(
    task: Row,
    token: string,
    version: Row,
    revision: Row,
    profile: ModelProfile,
    report?: (progress: object) => Promise<void>,
  ) {
    const pdf = !!version.originalPath && /\.pdf$/i.test(version.filename);
    const counters: IndexProgress = {
      pages: { completed: 0, total: null },
      regions: { completed: 0, total: null },
      embedding: { completed: 0, total: null },
      indexing: { completed: 0, total: null },
    };
    const controller = new AbortController();
    const checkOwned = async () => {
      controller.signal.throwIfAborted();
      try {
        await this.guard(task, token);
      } catch (error) {
        if (error instanceof Superseded) controller.abort(error);
        throw error;
      }
    };
    let failure: unknown;
    const checkPending = () => {
      controller.signal.throwIfAborted();
      if (failure) throw failure;
    };
    let progressQueue = Promise.resolve();
    let lastReport = 0;
    let lastStage = { stage: 'parsing', completed: 0, total: null as number | null };
    const update = (stage: string, completed: number, total: number | null, force = false) => {
      const time = Date.now();
      const changed = stage !== lastStage.stage;
      lastStage = { stage, completed, total };
      if (!force && !changed && time - lastReport < 350) return progressQueue;
      lastReport = time;
      const snapshot = pdf ? structuredClone(counters) : undefined;
      progressQueue = progressQueue.then(() =>
        this.progress(task, token, stage, completed, total, report, snapshot),
      );
      return progressQueue;
    };
    const context: ParseContext = {
      userId: task.userId,
      documentId: task.documentId,
      versionId: version.id,
      guard: checkOwned,
      signal: controller.signal,
      beforeRequest: checkPending,
      failed: (error) => {
        failure ||= error;
      },
      stage: (stage, done, total) => update(stage, done, total),
      progress: (progress) => {
        counters.pages = { completed: progress.pages, total: progress.totalPages };
        counters.regions = { completed: progress.regions, total: progress.totalRegions };
        return update(lastStage.stage, lastStage.completed, lastStage.total);
      },
    };
    const existing = await this.withExecution(task, token, async (tx, doc) => {
      if (doc.activeIndexRevisionId === revision.id)
        throw new ApiError(409, '不能重建正在使用的索引版本');
      await tx.save('indexRevisions', { id: revision.id, status: 'building' });
      const chunks = await tx.list('chunks', { indexRevisionId: revision.id });
      return new Map(chunks.map((chunk) => [chunk.chunkIndex, chunk.id]));
    });
    // 重试重写隐藏版本，清掉上次执行可能留下的尾部向量。
    if (existing.size)
      await this.withVectorExecution(task, token, () =>
        Promise.resolve(this.vectors.removeRevision(revision.id, task.userId, profile)),
      );
    const batchSize = profile.provider === 'dashscope' ? REMOTE_EMBEDDING_BATCH_SIZE : 16;
    const concurrency = profile.provider === 'dashscope' ? REMOTE_EMBEDDING_CONCURRENCY : 1;
    const metrics = {
      chunkMs: 0,
      embeddingBatchMs: 0,
      embeddingBatches: 0,
      cacheHits: 0,
      startedWhileParsing: 0,
      vectorWriteMs: 0,
    };
    const pending = new Set<Promise<void>>();
    let batch: IndexBlock[] = [];
    let count = 0;
    let firstVector: number[] | undefined;
    let parseDone = false;
    const submit = async () => {
      while (pending.size >= concurrency) {
        await Promise.race(pending);
        checkPending();
      }
      checkPending();
      const current = batch;
      const offset = count;
      batch = [];
      count += current.length;
      let job: Promise<void>;
      job = (async () => {
        const segments = await this.withExecution(task, token, async (tx, doc) => {
          const result: Segment[] = [];
          for (const [index, block] of current.entries()) {
            const chunkIndex = offset + index;
            const chunk = await tx.save('chunks', {
              id: existing.get(chunkIndex),
              documentId: doc.id,
              versionId: version.id,
              indexRevisionId: revision.id,
              chunkIndex,
              ...block,
            });
            result.push({
              userId: doc.userId,
              knowledgeBaseId: doc.knowledgeBaseId,
              documentId: doc.id,
              versionId: version.id,
              indexRevisionId: revision.id,
              chunkId: chunk.id,
              chunkIndex,
              filename: version.filename,
              ...block,
            });
          }
          return result;
        });
        checkPending();
        if (parseDone && lastStage.stage !== 'indexing')
          await update('embedding', counters.embedding.completed, counters.embedding.total);
        const embeddingStarted = Date.now();
        if (!parseDone) metrics.startedWhileParsing++;
        const { vectors, cacheHit } = await this.embedBatch(context, profile, segments, checkOwned);
        metrics.embeddingBatchMs += Date.now() - embeddingStarted;
        metrics.embeddingBatches++;
        if (cacheHit) metrics.cacheHits++;
        counters.embedding.completed += segments.length;
        // 文档级向量锁让重投和清理等待当前 RPC，数据库行锁在网络调用前已释放。
        const writeStarted = Date.now();
        await this.withVectorExecution(task, token, async () =>
          this.vectors.addAll(vectors, segments, profile),
        );
        metrics.vectorWriteMs += Date.now() - writeStarted;
        firstVector ||= vectors[0];
        counters.indexing.completed += segments.length;
        await update(
          parseDone ? 'indexing' : lastStage.stage,
          parseDone ? counters.indexing.completed : lastStage.completed,
          parseDone ? counters.indexing.total : lastStage.total,
        );
      })()
        .catch((error) => {
          failure ||= error;
        })
        .finally(() => pending.delete(job));
      pending.add(job);
    };

    let polling: Promise<void> | undefined;
    const poll = setInterval(() => {
      if (!polling)
        polling = checkOwned()
          .catch((error) => {
            failure ||= error;
          })
          .finally(() => {
            polling = undefined;
          });
    }, 1000);
    poll.unref();
    const pages: string[] = [];
    let textOffset = 0;
    try {
      await update('parsing', 0, null, true);
      const parts = await this.parseParts(version, context, pdf);
      const tokenizer = new TokenizerService(this.config);
      for await (const part of parts) {
        checkPending();
        const chunkStarted = Date.now();
        const blocks = revision.modelProfile
          ? await this.chunker.splitTokenStructured(part, tokenizer, profile, textOffset)
          : this.chunker.splitStructured(part, undefined, undefined, textOffset);
        metrics.chunkMs += Date.now() - chunkStarted;
        pages.push(part.text);
        textOffset += part.text.length + 1;
        for (const block of blocks) {
          batch.push(block);
          if (batch.length === batchSize) await submit();
        }
      }
      parseDone = true;
      counters.embedding.total = counters.indexing.total = count + batch.length;
      if (!counters.indexing.total) throw new ApiError(400, '文档未提取到有效片段');
      await update('embedding', counters.embedding.completed, counters.embedding.total, true);
      if (batch.length) await submit();
      await Promise.all(pending);
      checkPending();
      await checkOwned();
      // 发布前确认写入的新索引可被实际检索。
      const check = await this.vectors.search(firstVector!, 1, 0, {
        userId: task.userId,
        knowledgeBaseId: task.knowledgeBaseId,
        indexRevisionIds: [revision.id],
        modelProfile: profile,
      });
      if (!check.length) throw new Error('向量写入后无法查询，尚未发布索引');
      await this.withExecution(task, token, async (tx) => {
        for (const [index, id] of existing) {
          if (index >= count) await tx.delete('chunks', id);
        }
      });
      await update('indexing', count, count, true);
      return { text: pages.join('\n'), count, metrics: pdf ? metrics : undefined };
    } catch (error) {
      failure ||= error;
      // 失败时先收敛已发请求，等待期间仍可检测删除或任务取代。
      await Promise.all(pending);
      throw controller.signal.reason || failure;
    } finally {
      clearInterval(poll);
      await Promise.all(pending);
      await polling;
      await progressQueue.catch(() => {});
    }
  }

  private async parseParts(version: Row, context: ParseContext, pdf: boolean) {
    if (version.originalPath) {
      if (basename(version.originalPath) !== version.originalPath)
        throw new ApiError(400, '原件路径无效');
      const bytes = await readFile(
        join(this.config.getOrThrow('ORIGINALS_DIR'), version.originalPath),
      );
      const progress = async (done: number, total: number) => {
        await context.stage?.('parsing', done, total);
      };
      return pdf
        ? this.parser.parsePages(bytes, context, progress)
        : [await this.parser.parseStructured(bytes, version.filename, progress, context)];
    }
    if (/\.pdf$/i.test(version.filename) && this.config.get('VISION_ENABLED'))
      throw new ApiError(400, '历史 PDF 没有保留原件，无法识别图片，请重新上传原 PDF');
    if (!version.content?.trim()) throw new ApiError(400, '历史文档无正文，请重新上传');
    await context.stage?.('parsing', 1, 1);
    const text = version.content as string;
    return [{ text, blocks: paragraphBlocks(text, null) }];
  }

  private async embedBatch(
    context: ParseContext,
    profile: ModelProfile,
    batch: Segment[],
    checkOwned: () => Promise<void>,
  ) {
    const texts = batch.map((s) =>
      typeof s.retrievalMetadata?.embeddingText === 'string'
        ? s.retrievalMetadata.embeddingText
        : s.text,
    );
    const cacheProfile = digest(
      JSON.stringify({
        kind: 'embedding-batch-v1',
        profile,
        baseUrl:
          profile.provider === 'dashscope' ? this.config.get('EMBEDDING_BASE_URL') : undefined,
      }),
    );
    const directory = this.assets?.directory(context, cacheProfile);
    const input = digest(JSON.stringify(texts));
    const path = directory && join(directory, `vectors-${input}.json`);
    const valid = (value: unknown, dimensions?: number): value is number[][] =>
      Array.isArray(value) &&
      value.length === texts.length &&
      value.every(
        (v) =>
          Array.isArray(v) &&
          v.length &&
          (dimensions == null || dimensions === v.length) &&
          v.every(Number.isFinite) &&
          v.some((x) => x !== 0),
      );
    await checkOwned();
    if (path) {
      try {
        const cached = JSON.parse(await readFile(path, 'utf8'));
        if (
          cached?.profile === cacheProfile &&
          cached?.input === input &&
          valid(cached.vectors, profile.dimensions)
        )
          return { vectors: cached.vectors as number[][], cacheHit: true };
      } catch (error: any) {
        if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
      }
    }
    context.beforeRequest?.();
    const vectors = await this.embeddings.embedDocuments(texts, profile, context.signal);
    if (!valid(vectors)) throw new Error('Invalid embedding response');
    await checkOwned();
    if (path && directory && valid(vectors, profile.dimensions)) {
      const temporary = path + '.' + randomUUID() + '.tmp';
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify({ profile: cacheProfile, input, vectors }));
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }
    return { vectors, cacheHit: false };
  }

  // 清理必须等待保留期和写入任务结束，否则可能删掉正在使用或刚写入的索引。
  private async cleanup(task: Row, token: string) {
    if (task.payload?.notBefore && wallTime(task.payload.notBefore) > wallTime(now()))
      throw new DependencyPending('索引仍在请求快照保留窗口');
    if (task.kind === 'retire') {
      if (task.payload?.notBefore && wallTime(task.payload.notBefore) > wallTime(now()))
        throw new DependencyPending('旧版索引仍在保留窗口');
      await this.store.withDocumentVectorLock(task.documentId, async (store) => {
        const doc = await store.get('documents', task.documentId);
        if (
          doc?.activeIndexRevisionId === task.indexRevisionId ||
          doc?.desiredIndexRevisionId === task.indexRevisionId
        )
          throw new ApiError(409, '不能清理生效或待发布的索引');
        if (
          (await store.list('tasks', { indexRevisionId: task.indexRevisionId })).some(
            (t) => t.kind === 'index' && t.executionToken,
          )
        )
          throw new DependencyPending('等待索引写入任务终止');
        await this.vectors.removeRevision(task.indexRevisionId, task.userId);
      });
      for (const chunk of await this.store.list('chunks', {
        indexRevisionId: task.indexRevisionId,
      }))
        await this.store.delete('chunks', chunk.id);
      await this.store.save('indexRevisions', { id: task.indexRevisionId, status: 'cleaned' });
    } else if (task.kind === 'cleanup') {
      await this.store.withDocumentVectorLock(task.documentId, async (store) => {
        const doc = await store.get('documents', task.documentId);
        if (!doc?.deletedAt) throw new ApiError(409, '文档未删除，拒绝清理');
        const active = (await store.list('tasks', { documentId: task.documentId })).some(
          (t) => t.kind === 'index' && t.executionToken,
        );
        if (active) throw new DependencyPending('等待文档处理任务终止后清理');
        await this.vectors.removeDocument(task.documentId, task.userId);
      });
      await this.assets?.removeDocument(task.userId, task.documentId);
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
