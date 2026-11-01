import 'reflect-metadata';
import { createConnection } from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork, ChildProcess, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import request from 'supertest';
import { mysqlOptions } from '../src/persistence/data-source';
import { MysqlStore } from '../src/persistence/mysql.store';
import { configureApp } from '../src/bootstrap';
import { EmbeddingsService } from '../src/modules/embeddings/embeddings.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { TaskQueueRuntime } from '../src/modules/tasks/task-queue.runtime';
import { KnowledgeBases1793404800000 } from '../src/persistence/migrations/1793404800000-knowledge-bases';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Queue } from 'bullmq';
import { embeddingFingerprint } from '../src/modules/vector-store/qdrant-vector-store.service';
import { QdrantVectorStore } from '../src/modules/vector-store/qdrant-vector-store.service';
import { legacyModelProfile, ModelProfile } from '../src/modules/embeddings/model-profile';
import { RagQuality1793491200000 } from '../src/persistence/migrations/1793491200000-rag-quality';

const enabled = process.env.RAG_INTEGRATION === '1';
(enabled ? describe : describe.skip)(
  'real cross-process MySQL + Redis/BullMQ + Qdrant pipeline',
  () => {
    const suffix = randomBytes(6).toString('hex'),
      name = 'ai_rag_pipeline_test_' + suffix;
    let admin: Awaited<ReturnType<typeof createConnection>>,
      source: DataSource,
      store: MysqlStore,
      app: any;
    let worker: ChildProcess | undefined,
      directory: string,
      token: string,
      kbId: number,
      documentId: number;
    const headers = () => ({ Authorization: 'Bearer ' + token });
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    async function startWorker() {
      worker = fork(resolve('test/worker-fixture.cjs'), [], {
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      worker.stderr?.on('data', () => undefined);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker startup timed out')), 15000);
        worker!.once('message', (message: any) => {
          clearTimeout(timer);
          message.ready ? resolve() : reject(new Error(message.error));
        });
        worker!.once('exit', (code) => {
          if (code) {
            clearTimeout(timer);
            reject(new Error('Worker exited: ' + code));
          }
        });
      });
    }
    async function stopWorker() {
      if (!worker || worker.exitCode != null) return;
      const exited = once(worker, 'exit');
      worker.send('shutdown');
      await exited;
      worker = undefined;
    }
    async function waitTask(id: number, allowed = ['completed']) {
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const task = await store.get('tasks', id);
        if (allowed.includes(task!.status)) return task!;
        if (task!.status === 'failed') throw new Error('Task failed: ' + task!.error);
        await delay(100);
      }
      throw new Error('Task timed out: ' + JSON.stringify(await store.get('tasks', id)));
    }
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'rag-real-pipeline-'));
      admin = await createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      });
      await admin.query('CREATE DATABASE ' + name + ' CHARACTER SET utf8mb4');
      process.env.DB_NAME = name;
      process.env.STORAGE_DRIVER = 'mysql';
      process.env.VECTOR_DRIVER = 'qdrant';
      process.env.QUEUE_DRIVER = 'bullmq';
      process.env.QDRANT_COLLECTION = 'test_' + suffix;
      process.env.QUEUE_PREFIX = 'test-' + suffix;
      process.env.ORIGINALS_DIR = join(directory, 'originals');
      process.env.UPLOAD_TEMP_DIR = join(directory, 'chunks');
      source = new DataSource(mysqlOptions(process.env));
      await source.initialize();
      await source.runMigrations();
      store = new MysqlStore(source.manager);
      const { AppModule } = await import('../src/app.module');
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EmbeddingsService)
        .useValue({
          embedDocuments: async (texts: string[]) => texts.map(() => [1, ...Array(383).fill(0)]),
          embedQuery: async () => [1, ...Array(383).fill(0)],
        })
        .overrideProvider(LlmService)
        .useValue({
          complete: async () => '引用事实[1]，虚构编号[999]',
          stream: async function* () {
            yield '引用事实[1]';
            yield '，虚构编号[999]';
          },
        })
        .compile();
      app = module.createNestApplication();
      configureApp(app);
      await app.init();
      const auth = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ username: 'real-user', password: 'secret123' })
        .expect(200);
      token = auth.body.data.token;
      const kb = await request(app.getHttpServer())
        .post('/api/knowledge-bases')
        .set(headers())
        .send({ name: '真实测试库' })
        .expect(200);
      kbId = kb.body.data.id;
    }, 30000);
    afterAll(async () => {
      await stopWorker();
      await app?.close();
      if (source?.isInitialized) await source.destroy();
      const url = new URL(process.env.REDIS_URL!);
      for (const queueName of ['documents', 'cleanup', 'qa']) {
        const queue = new Queue(queueName, {
          prefix: process.env.QUEUE_PREFIX,
          connection: { host: url.hostname, port: Number(url.port) },
        });
        try {
          await queue.obliterate({ force: true });
        } finally {
          await queue.close();
        }
      }
      const client = new QdrantClient({ url: process.env.QDRANT_URL!, checkCompatibility: false });
      for (const collection of (await client.getCollections()).collections) {
        if (collection.name.startsWith(process.env.QDRANT_COLLECTION + '_'))
          await client.deleteCollection(collection.name);
      }
      if (admin) {
        if (!/^ai_rag_pipeline_test_[a-f0-9]{12}$/.test(name))
          throw new Error('Unsafe database cleanup');
        await admin.query('DROP DATABASE ' + name);
        await admin.end();
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    }, 30000);

    it('keeps real legacy384 and api1024 vector spaces independent without external model calls', async () => {
      const vectors = new QdrantVectorStore(
        new ConfigService({
          QDRANT_URL: process.env.QDRANT_URL,
          QDRANT_COLLECTION: process.env.QDRANT_COLLECTION,
          EMBEDDING_PROVIDER: 'local',
        }),
      );
      const legacy = legacyModelProfile();
      const api: ModelProfile = {
        provider: 'dashscope',
        model: 'text-embedding-v4',
        revision: 'api-v1',
        dimensions: 1024,
        tokenizer: '/test/tokenizer',
        chunkingVersion: 'tokens-v1',
      };
      const segment = {
        userId: 777,
        knowledgeBaseId: 888,
        documentId: 999,
        versionId: 1,
        indexRevisionId: 10000,
        chunkId: 20000,
        chunkIndex: 0,
        filename: 'space-test.md',
        text: '向量空间测试',
      };
      await vectors.addAll([[1, ...Array(383).fill(0)]], [segment], legacy);
      await vectors.addAll(
        [[1, ...Array(1023).fill(0)]],
        [{ ...segment, indexRevisionId: 10001, chunkId: 20001 }],
        api,
      );
      const baseScope = { userId: 777, knowledgeBaseId: 888 };
      expect(
        await vectors.search([1, ...Array(383).fill(0)], 5, 0, {
          ...baseScope,
          indexRevisionIds: [10000],
          modelProfile: legacy,
        }),
      ).toHaveLength(1);
      expect(
        await vectors.search([1, ...Array(1023).fill(0)], 5, 0, {
          ...baseScope,
          indexRevisionIds: [10001],
          modelProfile: api,
        }),
      ).toHaveLength(1);
      expect(
        await vectors.search([1, ...Array(1023).fill(0)], 5, 0, {
          ...baseScope,
          userId: 778,
          indexRevisionIds: [10001],
          modelProfile: api,
        }),
      ).toHaveLength(0);
      await vectors.removeRevision(10001, 777, api);
      expect(
        await vectors.search([1, ...Array(383).fill(0)], 5, 0, {
          ...baseScope,
          indexRevisionIds: [10000],
          modelProfile: legacy,
        }),
      ).toHaveLength(1);
    });
    it('repeats a legacy upgrade safely, preserving text without manufacturing PDF page numbers', async () => {
      const user = await store.save('users', { username: 'legacy', password: 'hash' });
      const doc = await store.save('documents', {
        userId: user.id,
        filename: 'legacy.pdf',
        content: '历史正文',
      });
      const runner = source.createQueryRunner();
      try {
        await new KnowledgeBases1793404800000().up(runner);
        await new KnowledgeBases1793404800000().up(runner);
        await new RagQuality1793491200000().up(runner);
        await new RagQuality1793491200000().up(runner);
      } finally {
        await runner.release();
      }
      const saved = (await store.get('documents', doc.id))!;
      expect(saved.knowledgeBaseId).toBeTruthy();
      expect(saved.activeVersionId).toBeTruthy();
      expect(await store.list('versions', { documentId: doc.id })).toHaveLength(1);
    });
    it('accepts uploads while no worker is running, then indexes in a separate worker process', async () => {
      const upload = await request(app.getHttpServer())
        .post('/api/upload')
        .set(headers())
        .field('knowledgeBaseId', String(kbId))
        .attach('file', Buffer.from('# 第一版\n\n真实来源内容'), 'source.md')
        .expect(202);
      documentId = upload.body.data.documentId;
      await app.get(TaskQueueRuntime).dispatch();
      expect((await store.get('tasks', upload.body.data.taskId))!.status).toBe('queued');
      await startWorker();
      await waitTask(upload.body.data.taskId);
      const indexed = (await store.get('documents', documentId))!;
      const revision = (await store.get('indexRevisions', indexed.activeIndexRevisionId))!;
      expect(revision.modelProfile).toMatchObject({
        provider: 'local',
        dimensions: 384,
        chunkingVersion: 'tokens-v1',
      });
      const indexedChunks = await store.list('chunks', { indexRevisionId: revision.id });
      expect(indexedChunks[0].retrievalMetadata.parentText).toContain('真实来源内容');
      expect(indexedChunks[0].retrievalMetadata.tokenCount).toBeGreaterThan(0);
      const list = await request(app.getHttpServer())
        .get('/api/knowledge-bases/' + kbId + '/documents')
        .set(headers())
        .expect(200);
      expect(list.body.data.items[0]).toMatchObject({
        id: documentId,
        status: 'ready',
        activeIndexRevisionId: expect.any(Number),
      });
    });
    it('normalizes streamed citations and stores the same canonical answer and JSON snapshots in MySQL', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/stream-chat')
        .set(headers())
        .send({ question: '内容', knowledgeBaseId: kbId })
        .expect(200);
      const final = JSON.parse(
        response.text
          .split('\n\n')
          .find((f: string) => f.startsWith('event: done'))!
          .split('\ndata: ')[1],
      );
      expect(final.answer).toBe('引用事实[1]，虚构编号');
      expect(final.citations).toHaveLength(1);
      const history = await request(app.getHttpServer())
        .get('/api/chats/' + final.chatId)
        .set(headers())
        .expect(200);
      expect(history.body.data.messages[1].content).toBe(final.answer);
      expect(history.body.data.messages[1].citations[0]).toMatchObject({
        filename: 'source.md',
        documentId,
      });
    });
    (process.env.TEST_REDIS_RESTART === '1' ? it : it.skip)(
      'recovers SQL outbox submissions after a real Redis outage',
      async () => {
        const compose = (action: string) =>
          execFileSync('docker', ['compose', action, 'redis-test'], {
            cwd: resolve('..'),
            stdio: 'pipe',
          });
        let taskId: number, recoveryDocumentId: number;
        compose('stop');
        try {
          const uploaded = await request(app.getHttpServer())
            .post('/api/upload')
            .set(headers())
            .field('knowledgeBaseId', String(kbId))
            .attach('file', Buffer.from('Redis恢复后的内容'), 'recovery.md')
            .expect(202);
          taskId = uploaded.body.data.taskId;
          recoveryDocumentId = uploaded.body.data.documentId;
          await delay(500);
          expect((await store.get('tasks', taskId))!.status).toBe('queued');
        } finally {
          compose('start');
        }
        await waitTask(taskId!);
        const removed = await request(app.getHttpServer())
          .delete('/api/documents/' + recoveryDocumentId!)
          .set(headers())
          .expect(202);
        await waitTask(removed.body.data.taskId);
      },
      60000,
    );
    it('survives worker restart, keeps versions isolated, rebuilds, then clears deleted vectors', async () => {
      await stopWorker();
      const update = await request(app.getHttpServer())
        .put('/api/documents/' + documentId + '/file')
        .set(headers())
        .attach('file', Buffer.from('新版独立内容'), 'source.md')
        .expect(202);
      const before = await store.get('documents', documentId);
      await app.get(TaskQueueRuntime).dispatch();
      await startWorker();
      await waitTask(update.body.data.taskId);
      expect((await store.get('documents', documentId))!.activeIndexRevisionId).not.toBe(
        before!.activeIndexRevisionId,
      );
      const answer = await request(app.getHttpServer())
        .post('/api/chat')
        .set(headers())
        .send({ question: '内容', knowledgeBaseId: kbId })
        .expect(200);
      expect(answer.body.data.citations[0].text).toBe('新版独立内容');
      const rebuild = await request(app.getHttpServer())
        .post('/api/knowledge-bases/' + kbId + '/reindex')
        .set(headers())
        .expect(202);
      await waitTask(rebuild.body.data.taskId);
      const deletion = await request(app.getHttpServer())
        .delete('/api/documents/' + documentId)
        .set(headers())
        .expect(202);
      await waitTask(deletion.body.data.taskId);
      expect((await store.get('documents', documentId))!.status).toBe('deleted');
      const empty = await request(app.getHttpServer())
        .post('/api/chat')
        .set(headers())
        .send({ question: '内容', knowledgeBaseId: kbId })
        .expect(200);
      expect(empty.body.data.citations).toEqual([]);
    }, 30000);
    it('restores durable QA snapshots on the independent real worker queue after a restart', async () => {
      const upload = (
        await request(app.getHttpServer())
          .post('/api/upload')
          .set(headers())
          .field('knowledgeBaseId', String(kbId))
          .attach(
            'file',
            Buffer.from('Evidence and citations must be checked. '.repeat(200)),
            'qa-source.md',
          )
          .expect(202)
      ).body.data;
      await waitTask(upload.taskId);
      await stopWorker();
      const config = app.get(ConfigService),
        budget = config.get('RAG_EVIDENCE_TOKENS');
      config.set('RAG_EVIDENCE_TOKENS', 300);
      try {
        const body = {
          knowledgeBaseId: kbId,
          documentIds: [upload.documentId],
          mode: 'overview',
          question: '总结全文',
          requestId: '11111111-1111-4111-8111-111111111111',
        };
        const accepted = (
          await request(app.getHttpServer()).post('/api/chat').set(headers()).send(body).expect(202)
        ).body.data;
        const repeated = (
          await request(app.getHttpServer()).post('/api/chat').set(headers()).send(body).expect(202)
        ).body.data;
        expect(repeated.taskId).toBe(accepted.taskId);
        await startWorker();
        await waitTask(accepted.taskId);
        const history = (
          await request(app.getHttpServer())
            .get('/api/chats/' + accepted.chatId)
            .set(headers())
            .expect(200)
        ).body.data;
        expect(history.messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
        expect(history.messages.find((m: any) => m.role === 'assistant').citations).toHaveLength(1);
        expect(history.pendingTasks).toHaveLength(0);
      } finally {
        config.set('RAG_EVIDENCE_TOKENS', budget);
        if (!worker) await startWorker();
      }
    }, 30000);
  },
);
