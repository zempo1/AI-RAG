import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { configureApp } from '../src/bootstrap';
import { EmbeddingsService } from '../src/modules/embeddings/embeddings.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('existing Vue API contract', () => {
  let app: INestApplication;
  let token: string;
  let other: string;
  let doc: number;
  let failLlm = false;
  let slowStream = false;
  let observeAbort: () => void = () => undefined;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'memory';
    process.env.JWT_SECRET = 'test-secret-32-characters-or-longer';
    process.env.UPLOAD_TEMP_DIR = '.tmp/e2e';
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
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
          yield '中文\\路径\n"';
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
      .expect(200);
    expect(upload.body.data).toBe('File uploaded and ingested successfully.');
    const list = await request(app.getHttpServer()).get('/api/documents').set(auth()).expect(200);
    expect(list.body.data[0]).toEqual({
      id: expect.any(Number),
      filename: '知识文档.md',
      uploadTime: expect.any(String),
    });
    doc = list.body.data[0].id;
    const answer = await request(app.getHttpServer())
      .post('/api/chat')
      .set(auth())
      .send({ question: '内容是什么' })
      .expect(200);
    expect(answer.body.data).toBe('根据文档回答');
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
    await request(app.getHttpServer())
      .post('/api/upload')
      .set(auth())
      .attach('file', Buffer.from('%PDF-invalid'), 'bad.pdf')
      .expect(400);
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
    const md5 = '1234567890abcdef1234567890abcdef';
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
      .expect(200);
    expect(result.body.data.filename).toBe(filename);
    expect((await check().expect(200)).body.data).toEqual({ uploaded: true });
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
    expect(frames.map((s: string) => JSON.parse(s.slice(5)))).toEqual(['中文\\路径\n"', '答案']);
    const id = Number(res.text.match(/event: chatId\ndata: (\d+)/)![1]);
    const chat = await request(app.getHttpServer()).get(`/api/chats/${id}`).set(auth()).expect(200);
    expect(chat.body.data.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(chat.body.data.messages[1].content).toBe('中文\\路径\n"答案');
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
    expect(stream.text).toContain('[Error: upstream unavailable]');
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
});
