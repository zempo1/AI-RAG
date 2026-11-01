import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { configureApp } from '../src/bootstrap';
import { EmbeddingsService } from '../src/modules/embeddings/embeddings.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { QaTasksService } from '../src/modules/tasks/qa-tasks.service';
import { SummaryService } from '../src/modules/rag/summary.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexingService } from '../src/modules/documents/indexing.service';
import { TaskQueueRuntime } from '../src/modules/tasks/task-queue.runtime';

describe('existing Vue API contract', () => {
  let app: INestApplication;
  let token: string;
  let other: string;
  let doc: number;
  let directory: string;
  let failLlm = false;
  let slowStream = false;
  let observeAbort: () => void = () => undefined;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'memory';
    process.env.VECTOR_DRIVER = 'memory';
    process.env.QUEUE_DRIVER = 'memory';
    process.env.INDEX_RETENTION_MS = '0';
    process.env.JWT_SECRET = 'test-secret-32-characters-or-longer';
    directory = await mkdtemp(join(tmpdir(), 'rag-api-e2e-'));
    process.env.UPLOAD_TEMP_DIR = join(directory, 'chunks');
    process.env.ORIGINALS_DIR = join(directory, 'originals');
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TaskQueueRuntime)
      .useValue({})
      .overrideProvider(EmbeddingsService)
      .useValue({
        embedDocuments: async (texts: string[]) => texts.map(() => [1, 0]),
        embedQuery: async () => [1, 0],
      })
      .overrideProvider(LlmService)
      .useValue({
        complete: async (prompt: string) => {
          if (failLlm) throw new Error('upstream unavailable');
          if (prompt.startsWith('Generate a mind map'))
            return '{"root":{"data":{"text":"测试"},"children":[]}}';
          if (prompt.includes('Flashcard')) return '[{"q":"问题","a":"答案"}]';
          return '根据文档回答';
        },
        stream: async function* (_prompt: string, _key: string, signal: AbortSignal) {
          yield '中文\\路径\n"[1][99]';
          if (slowStream)
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  observeAbort();
                  reject(new Error('cancelled'));
                },
                { once: true },
              );
            });
          if (failLlm) throw new Error('upstream unavailable');
          yield '答案';
        },
      })
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('requires authentication and preserves the error envelope', async () => {
    const res = await request(app.getHttpServer()).get('/api/documents').expect(401);
    expect(res.body).toEqual({ code: 401, message: '未登录或登录已过期' });
  });
  it('registers and logs in real bcrypt users', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ username: 'alice', password: 'secret123' })
      .expect(200);
    expect(res.body.code).toBe(200);
    token = res.body.data.token;
    expect(res.body.data.username).toBe('alice');
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'secret123' })
      .expect(200);
    expect(login.body.data.token).toBeTruthy();
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'wrong' })
      .expect(401);
    const second = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ username: 'bob', password: 'secret123' })
      .expect(200);
    other = second.body.data.token;
  });
  it('uploads Markdown, lists only summaries and answers synchronously', async () => {
    const upload = await request(app.getHttpServer())
      .post('/api/upload')
      .set(auth())
      .attach('file', Buffer.from('# 知识\n\n中文文档内容'), '知识文档.md')
      .expect(202);
    expect(upload.body.data).toMatchObject({
      documentId: expect.any(Number),
      taskId: expect.any(Number),
    });
    await app.get(IndexingService).process(upload.body.data.taskId);
    const list = await request(app.getHttpServer()).get('/api/documents').set(auth()).expect(200);
    expect(list.body.data[0]).toMatchObject({
      id: expect.any(Number),
      filename: '知识文档.md',
      uploadTime: expect.any(String),
    });
    expect(list.body.data[0].content).toBeUndefined();
    doc = list.body.data[0].id;
    const answer = await request(app.getHttpServer())
      .post('/api/chat')
      .set(auth())
      .send({ question: '内容是什么' })
      .expect(200);
    expect(answer.body.data).toMatchObject({
      answer: '根据文档回答',
      citations: [],
      chatId: expect.any(Number),
      retrievalRunId: expect.any(Number),
    });
    await request(app.getHttpServer())
      .post('/api/documents/' + doc + '/activate')
      .set(auth())
      .expect(200);
  });
  it('rejects invalid, empty and oversized files and missing questions', async () => {
    await request(app.getHttpServer())
      .post('/api/upload')
      .set(auth())
      .attach('file', Buffer.from('bad'), 'bad.exe')
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/upload')
      .set(auth())
      .attach('file', Buffer.alloc(0), 'empty.md')
      .expect(400);
    const corrupt = await request(app.getHttpServer())
      .post('/api/upload')
      .set(auth())
      .attach('file', Buffer.from('%PDF-invalid'), 'bad.pdf')
      .expect(202);
    await expect(app.get(IndexingService).process(corrupt.body.data.taskId, 3)).rejects.toThrow();
    const failed = await request(app.getHttpServer())
      .get('/api/tasks/' + corrupt.body.data.taskId)
      .set(auth())
      .expect(200);
    expect(failed.body.data).toMatchObject({ status: 'failed', retryable: 0 });
    await request(app.getHttpServer())
      .post('/api/upload')
      .set(auth())
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), 'big.md')
      .expect(413);
    await request(app.getHttpServer())
      .post('/api/chat')
      .set(auth())
      .send({ question: ' ' })
      .expect(400);
  });
  it('supports resumable chunks, merge, quick upload and user isolation', async () => {
    const md5 = createHash('md5').update('hello 中文').digest('hex');
    const filename = 'chunks.md';
    const check = () =>
      request(app.getHttpServer()).get('/api/upload/check').query({ md5, filename }).set(auth());
    expect((await check().expect(200)).body.data).toEqual({ uploaded: false, uploadedChunks: [] });
    await request(app.getHttpServer())
      .post('/api/upload/chunk')
      .set(auth())
      .field({ md5, filename, chunkIndex: '0', totalChunks: '2' })
      .attach('file', Buffer.from('hello '), 'chunk_0')
      .expect(200);
    expect((await check().expect(200)).body.data.uploadedChunks).toEqual([0]);
    await request(app.getHttpServer())
      .post('/api/upload/merge')
      .set(auth())
      .send({ md5, filename, totalChunks: 2 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/upload/chunk')
      .set(auth())
      .field({ md5, filename, chunkIndex: '1', totalChunks: '2' })
      .attach('file', Buffer.from('中文'), 'chunk_1')
      .expect(200);
    const result = await request(app.getHttpServer())
      .post('/api/upload/merge')
      .set(auth())
      .send({ md5, filename, totalChunks: 2 })
      .expect(202);
    expect(result.body.data.filename).toBe(filename);
    expect((await check().expect(200)).body.data).toMatchObject({
      uploaded: true,
      documentId: result.body.data.documentId,
    });
    await app.get(IndexingService).process(result.body.data.taskId);
    const alien = await request(app.getHttpServer())
      .get('/api/upload/check')
      .query({ md5, filename })
      .set('Authorization', `Bearer ${other}`)
      .expect(200);
    expect(alien.body.data.uploaded).toBe(false);
  });
  it('streams original SSE frames and saves message history', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/stream-chat')
      .set(auth())
      .send({ question: '问题', chatId: null })
      .expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toMatch(/event: chatId\ndata: \d+\n\n/);
    const frames = res.text.split('\n\n').filter((s: string) => s.startsWith('data:'));
    expect(frames.map((s: string) => JSON.parse(s.slice(5)))).toEqual([
      '中文\\路径\n"[1][99]',
      '答案',
    ]);
    const id = Number(res.text.match(/event: chatId\ndata: (\d+)/)![1]);
    const chat = await request(app.getHttpServer()).get(`/api/chats/${id}`).set(auth()).expect(200);
    expect(chat.body.data.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(chat.body.data.messages[1].content).toBe('中文\\路径\n"[1]答案');
    expect(chat.body.data.messages[1].citations).toHaveLength(1);
    await request(app.getHttpServer())
      .get(`/api/chats/${id}`)
      .set('Authorization', `Bearer ${other}`)
      .expect(404);
    await request(app.getHttpServer()).delete(`/api/chats/${id}`).set(auth()).expect(200);
  });
  it('migrates analyses, flashcards and mind map CRUD', async () => {
    for (const type of ['SUMMARY', 'OUTLINE', 'FLASHCARD']) {
      const res = await request(app.getHttpServer())
        .post('/api/analysis/generate')
        .set(auth())
        .send({ documentId: doc, type })
        .expect(200);
      expect(res.body.data.type).toBe(type);
      const list = await request(app.getHttpServer())
        .get('/api/analysis')
        .query({ type })
        .set(auth())
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      await request(app.getHttpServer())
        .delete(`/api/analysis/${res.body.data.id}`)
        .set(auth())
        .expect(200);
    }
    const map = await request(app.getHttpServer())
      .post('/api/mindmaps/generate')
      .set(auth())
      .send({ documentId: doc })
      .expect(200);
    const id = map.body.data.id;
    expect(JSON.parse(map.body.data.data).root.data.text).toBe('测试');
    await request(app.getHttpServer())
      .put(`/api/mindmaps/${id}`)
      .set(auth())
      .send({ data: '{"root":{"data":{"text":"修改"},"children":[]}}' })
      .expect(200);
    await request(app.getHttpServer()).get(`/api/mindmaps/${id}`).set(auth()).expect(200);
    await request(app.getHttpServer()).delete(`/api/mindmaps/${id}`).set(auth()).expect(200);
  });
  it('returns genuine model errors instead of fake successful results', async () => {
    failLlm = true;
    const res = await request(app.getHttpServer())
      .post('/api/chat')
      .set(auth())
      .send({ question: '失败' })
      .expect(500);
    expect(res.body.message).toContain('upstream unavailable');
    const stream = await request(app.getHttpServer())
      .post('/api/stream-chat')
      .set(auth())
      .send({ question: '失败' })
      .expect(200);
    expect(stream.text).toContain('event: error');
    expect(stream.text).toContain('upstream unavailable');
    const errorFrame = stream.text
      .split('\n\n')
      .find((frame: string) => frame.startsWith('event: error'))!;
    const interrupted = JSON.parse(errorFrame.split('\ndata: ')[1]);
    expect(interrupted.answer).toBe('中文\\路径\n"[1]');
    expect(interrupted.citations).toHaveLength(1);
    expect(interrupted.generationStatus).toBe('interrupted');
    failLlm = false;
  });
  it('cancels the upstream generation when the browser disconnects', async () => {
    slowStream = true;
    const aborted = new Promise<void>((resolve) => (observeAbort = resolve));
    const port = (app.getHttpServer().address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/stream-chat',
          method: 'POST',
          headers: { ...auth(), 'Content-Type': 'application/json' },
        },
        (res) => {
          res.on('data', (chunk) => {
            if (chunk.toString().includes('中文')) {
              res.destroy();
              req.destroy();
              resolve();
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ question: '断开测试' }));
    });
    await Promise.race([
      aborted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('upstream was not cancelled')), 2000).unref(),
      ),
    ]);
    slowStream = false;
  });
  it('manages scoped categories and metadata and keeps a deleted-library chat read-only', async () => {
    const kb = (
      await request(app.getHttpServer())
        .post('/api/knowledge-bases')
        .set(auth())
        .send({ name: '私有新库' })
        .expect(200)
    ).body.data;
    const category = (
      await request(app.getHttpServer())
        .post('/api/knowledge-bases/' + kb.id + '/categories')
        .set(auth())
        .send({ name: '课程' })
        .expect(200)
    ).body.data;
    const accepted = (
      await request(app.getHttpServer())
        .post('/api/upload')
        .set(auth())
        .field('knowledgeBaseId', String(kb.id))
        .field('categoryId', String(category.id))
        .attach('file', Buffer.from('分类正文'), 'course.md')
        .expect(202)
    ).body.data;
    await app.get(IndexingService).process(accepted.taskId);
    const before = (
      await request(app.getHttpServer())
        .get('/api/documents/' + accepted.documentId)
        .set(auth())
        .expect(200)
    ).body.data;
    await request(app.getHttpServer())
      .put('/api/documents/' + accepted.documentId)
      .set(auth())
      .send({ filename: 'renamed.md' })
      .expect(200);
    const after = (
      await request(app.getHttpServer())
        .get('/api/documents/' + accepted.documentId)
        .set(auth())
        .expect(200)
    ).body.data;
    expect(after.activeIndexRevisionId).toBe(before.activeIndexRevisionId);
    await request(app.getHttpServer())
      .get('/api/knowledge-bases/' + kb.id + '/documents')
      .set('Authorization', 'Bearer ' + other)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/tasks/' + accepted.taskId)
      .set('Authorization', 'Bearer ' + other)
      .expect(404);
    await request(app.getHttpServer())
      .delete('/api/knowledge-bases/' + kb.id + '/categories/' + category.id)
      .set(auth())
      .expect(200);
    const docs = (
      await request(app.getHttpServer())
        .get('/api/knowledge-bases/' + kb.id + '/documents')
        .query({ categoryId: 0 })
        .set(auth())
        .expect(200)
    ).body.data;
    expect(docs.items[0]).toMatchObject({ filename: 'renamed.md', categoryId: null });
    const chat = (
      await request(app.getHttpServer())
        .post('/api/chats')
        .set(auth())
        .send({ knowledgeBaseId: kb.id, title: '绑定库' })
        .expect(200)
    ).body.data;
    const otherKb = (
      await request(app.getHttpServer()).get('/api/knowledge-bases').set(auth()).expect(200)
    ).body.data.find((row: any) => row.id !== kb.id);
    await request(app.getHttpServer())
      .post('/api/stream-chat')
      .set(auth())
      .send({ chatId: chat.id, knowledgeBaseId: otherKb.id, question: '问题' })
      .expect(400);
    await request(app.getHttpServer())
      .delete('/api/knowledge-bases/' + kb.id)
      .set(auth())
      .expect(202);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/chats/' + chat.id)
          .set(auth())
          .expect(200)
      ).body.data.readOnly,
    ).toBe(true);
    await request(app.getHttpServer())
      .post('/api/stream-chat')
      .set(auth())
      .send({ chatId: chat.id, question: '问题' })
      .expect(409);
  });
  it('protects task history endpoints and retains internal records', async () => {
    const uploaded = (
      await request(app.getHttpServer())
        .post('/api/upload')
        .set(auth())
        .attach('file', Buffer.from('任务历史'), 'history.md')
        .expect(202)
    ).body.data;
    await request(app.getHttpServer())
      .delete('/api/tasks/' + uploaded.taskId)
      .set({ Authorization: 'Bearer ' + other })
      .expect(404);
    await request(app.getHttpServer())
      .delete('/api/tasks/' + uploaded.taskId)
      .set(auth())
      .expect(409);
    await app.get(IndexingService).process(uploaded.taskId);
    await request(app.getHttpServer())
      .delete('/api/tasks/' + uploaded.taskId)
      .set(auth())
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/tasks/' + uploaded.taskId)
      .set(auth())
      .expect(200);
    const list = await request(app.getHttpServer())
      .get('/api/tasks')
      .query({ knowledgeBaseId: uploaded.knowledgeBaseId })
      .set(auth())
      .expect(200);
    expect(list.body.data.some((t: any) => t.id === uploaded.taskId)).toBe(false);
    await request(app.getHttpServer())
      .delete('/api/tasks')
      .query({ knowledgeBaseId: uploaded.knowledgeBaseId })
      .set({ Authorization: 'Bearer ' + other })
      .expect(404);
    await request(app.getHttpServer())
      .delete('/api/tasks')
      .query({ knowledgeBaseId: uploaded.knowledgeBaseId })
      .set(auth())
      .expect(200);
  });

  it('queues long overviews once, restores pending history, and protects internal snapshots', async () => {
    const config = app.get(ConfigService),
      previousBudget = config.get('RAG_EVIDENCE_TOKENS');
    config.set('RAG_EVIDENCE_TOKENS', 300);
    const summary = app.get(SummaryService),
      original = summary.summarize.bind(summary);
    summary.summarize = async (snapshot: any) =>
      ({
        answer: '完整总结[1]',
        citations: snapshot.sources.slice(0, 1),
        coverage: { complete: true },
        diagnostics: snapshot.diagnostics,
      }) as any;
    try {
      const upload = await request(app.getHttpServer())
        .post('/api/upload')
        .set(auth())
        .attach(
          'file',
          Buffer.from('# 章节\n\n' + '知识库证据覆盖。'.repeat(400)),
          'long-overview.md',
        )
        .expect(202);
      await app.get(IndexingService).process(upload.body.data.taskId);
      const body = {
        question: '总结全文',
        mode: 'overview',
        documentIds: [upload.body.data.documentId],
        knowledgeBaseId: upload.body.data.knowledgeBaseId,
        requestId: randomUUID(),
      };
      const first = await request(app.getHttpServer())
        .post('/api/chat')
        .set(auth())
        .send(body)
        .expect(202);
      const second = await request(app.getHttpServer())
        .post('/api/chat')
        .set(auth())
        .send(body)
        .expect(202);
      expect(second.body.data.taskId).toBe(first.body.data.taskId);
      const stream = await request(app.getHttpServer())
        .post('/api/stream-chat')
        .set(auth())
        .send(body)
        .expect(200);
      expect(stream.text).toContain('event: accepted');
      const taskId = first.body.data.taskId,
        chatId = first.body.data.chatId;
      const task = await request(app.getHttpServer())
        .get('/api/tasks/' + taskId)
        .set(auth())
        .expect(200);
      expect(task.body.data.payload.snapshot).toBeUndefined();
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/chats/' + chatId)
            .set(auth())
            .expect(200)
        ).body.data.pendingTasks,
      ).toHaveLength(1);
      await app.get(QaTasksService).process(taskId);
      await app.get(QaTasksService).process(taskId);
      const history = (
        await request(app.getHttpServer())
          .get('/api/chats/' + chatId)
          .set(auth())
          .expect(200)
      ).body.data;
      expect(history.messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
      expect(history.pendingTasks).toHaveLength(0);
      const runId = history.messages.find((m: any) => m.role === 'assistant').retrievalRunId;
      await request(app.getHttpServer())
        .get('/api/retrieval-runs/' + runId)
        .set(auth())
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/retrieval-runs/' + runId)
        .set('Authorization', 'Bearer ' + other)
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/chat')
        .set(auth())
        .send({ ...body, question: 'different' })
        .expect(409);
    } finally {
      config.set('RAG_EVIDENCE_TOKENS', previousBudget);
      summary.summarize = original;
    }
  });

  it('keeps streamed retrieval diagnostics after history reload', async () => {
    const a = (
      await request(app.getHttpServer())
        .post('/api/upload')
        .set(auth())
        .attach('file', Buffer.from('诊断回归的原文证据'), 'diagnostics.md')
        .expect(202)
    ).body.data;
    await app.get(IndexingService).process(a.taskId);
    const stream = await request(app.getHttpServer())
      .post('/api/stream-chat')
      .set(auth())
      .send({
        question: '原文证据',
        knowledgeBaseId: a.knowledgeBaseId,
        documentIds: [a.documentId],
      })
      .expect(200);
    const done = JSON.parse(stream.text.split('event: done\ndata: ')[1].split('\n\n')[0]);
    const history = (
      await request(app.getHttpServer())
        .get('/api/chats/' + done.chatId)
        .set(auth())
        .expect(200)
    ).body.data;
    const answer = history.messages.find((m: any) => m.role === 'assistant');
    expect(answer.retrievalRunId).toBe(done.retrievalRunId);
    expect(answer.diagnostics.runId).toBe(done.retrievalRunId);
  });
});
