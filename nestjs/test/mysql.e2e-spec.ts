import 'reflect-metadata';
import { createConnection } from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { mysqlOptions } from '../src/persistence/data-source';
import { MysqlStore, verifySchema } from '../src/persistence/mysql.store';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/bootstrap';
import { EmbeddingsService } from '../src/modules/embeddings/embeddings.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { DocumentCascade1793376000000 } from '../src/persistence/migrations/1793376000000-document-cascade';
import { IndexingService } from '../src/modules/documents/indexing.service';
import { TaskQueueRuntime } from '../src/modules/tasks/task-queue.runtime';

const enabled = process.env.MYSQL_INTEGRATION === '1';

(enabled ? describe : describe.skip)('real MySQL (isolated disposable database)', () => {
  let source: DataSource;
  let admin: Awaited<ReturnType<typeof createConnection>>;
  let store: MysqlStore;
  const name = 'ai_rag_nest_test_' + randomBytes(6).toString('hex');
  beforeAll(async () => {
    admin = await createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
    source = new DataSource(mysqlOptions({ ...process.env, DB_NAME: name }));
    await source.initialize();
    await source.runMigrations();
    await verifySchema(source);
    store = new MysqlStore(source.manager);
  });
  afterAll(async () => {
    if (source?.isInitialized) await source.destroy();
    // Only this run's cryptographically named test database can be dropped.
    if (admin) {
      if (!/^ai_rag_nest_test_[a-f0-9]{12}$/.test(name)) throw new Error('Unsafe test database');
      await admin.query(`DROP DATABASE \`${name}\``);
      await admin.end();
    }
  });
  it('persists records, enforces unique usernames and rolls back transactions', async () => {
    const user = await store.save('users', { username: 'mysql-user', password: 'hash' });
    expect(user.id).toBe(1);
    await expect(
      store.save('users', { username: 'mysql-user', password: 'other' }),
    ).rejects.toThrow('Username already exists');
    await expect(
      store.transaction(async (tx) => {
        await tx.save('documents', {
          userId: user.id,
          filename: 'rollback.md',
          content: 'rollback',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await store.list('documents')).toEqual([]);
    const doc = await store.save('documents', {
      userId: user.id,
      filename: '中文.md',
      content: '持久化内容',
    });
    expect(doc.content).toBe('持久化内容');
    expect(typeof doc.uploadTime).toBe('string');
    await source.destroy();
    await source.initialize();
    store = new MysqlStore(source.manager);
    expect((await store.get('documents', doc.id))?.content).toBe('持久化内容');
  });
  it('preserves database wall time across UTC hosts and repeated updates', async () => {
    const original = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const row = await store.save('mindmaps', {
        userId: 1,
        title: 'timezone',
        data: '{}',
        createdAt: '2026-10-29T12:34:56.000',
      });
      expect(row.createdAt).toBe('2026-10-29T12:34:56.000000');
      const updated = await store.save('mindmaps', { ...row, title: 'updated' });
      expect(updated.createdAt).toBe('2026-10-29T12:34:56.000000');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
  it('deletes messages and chat transactionally and checks existing schema without changes', async () => {
    const chat = await store.save('chats', { userId: 1, title: 'chat' });
    await store.save('messages', { chatId: chat.id, role: 'user', content: '消息' });
    await store.transaction(async (tx) => {
      for (const message of await tx.list('messages', { chatId: chat.id }))
        await tx.delete('messages', message.id);
      await tx.delete('chats', chat.id);
    });
    expect(await store.list('messages')).toEqual([]);
    expect(await store.get('chats', chat.id)).toBeUndefined();
    await verifySchema(source);
  });
  it('fails on missing database tables rather than synchronizing them', async () => {
    await source.query('RENAME TABLE mind_maps TO saved_mind_maps');
    await expect(verifySchema(source)).rejects.toThrow('缺少表');
    await source.query('RENAME TABLE saved_mind_maps TO mind_maps');
  });
  it('cascades a raw document deletion to all associated results without deleting legacy maps', async () => {
    const doc = await store.save('documents', {
      userId: 1,
      filename: 'cascade.md',
      content: 'test',
    });
    for (const type of ['SUMMARY', 'OUTLINE', 'FLASHCARD']) {
      await store.save('analyses', { userId: 1, documentId: doc.id, type, content: 'result' });
    }
    await store.save('mindmaps', { userId: 1, documentId: doc.id, title: 'linked', data: '{}' });
    const legacy = await store.save('mindmaps', { userId: 1, title: 'legacy', data: '{}' });
    await source.query('DELETE FROM document_files WHERE id = ?', [doc.id]);
    expect(await store.list('analyses', { documentId: doc.id })).toEqual([]);
    expect(await store.list('mindmaps', { documentId: doc.id })).toEqual([]);
    expect(await store.get('mindmaps', legacy.id)).toBeDefined();
  });

  it('preserves historical orphan results and their original IDs when upgrading', async () => {
    const runner = source.createQueryRunner();
    try {
      const table = (await runner.getTable('document_analyses'))!;
      for (const key of table.foreignKeys.filter((k) => k.columnNames.includes('document_id')))
        await runner.dropForeignKey(table, key);
      const row = await store.save('analyses', {
        userId: 1,
        documentId: 999999,
        type: 'SUMMARY',
        content: '保留旧结果',
      });
      await new DocumentCascade1793376000000().up(runner);
      await new DocumentCascade1793376000000().up(runner);
      const [saved] = await runner.query(
        'SELECT document_id, legacy_document_id, content FROM document_analyses WHERE id=?',
        [row.id],
      );
      expect(saved.document_id).toBeNull();
      expect(Number(saved.legacy_document_id)).toBe(999999);
      expect(saved.content).toBe('保留旧结果');
    } finally {
      await runner.release();
    }
  });

  it('boots the complete MySQL-backed app and persists the upload/chat API flow', async () => {
    process.env.STORAGE_DRIVER = 'mysql';
    process.env.VECTOR_DRIVER = 'memory';
    process.env.QUEUE_DRIVER = 'memory';
    process.env.DB_NAME = name;
    process.env.JWT_SECRET = 'mysql-integration-test-secret-long-enough';
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
        complete: async () => '持久化回答',
        stream: async function* () {
          yield '持久化回答';
        },
      })
      .compile();
    const app = module.createNestApplication();
    configureApp(app);
    await app.init();
    try {
      const registration = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ username: 'api-user', password: 'secret123' })
        .expect(200);
      const auth = { Authorization: `Bearer ${registration.body.data.token}` };
      const userBefore = (await store.list('users', { username: 'api-user' }))[0];
      expect(userBefore.createdAt).toBeTruthy();
      const zone = process.env.DB_TIMEZONE || '+08:00';
      expect(Math.abs(new Date(userBefore.createdAt + zone).getTime() - Date.now())).toBeLessThan(
        10000,
      );
      await request(app.getHttpServer())
        .post('/api/auth/change-username')
        .set(auth)
        .send({ newUsername: 'renamed-api-user' })
        .expect(200);
      expect((await store.get('users', userBefore.id))!.createdAt).toBe(userBefore.createdAt);
      const accepted = await request(app.getHttpServer())
        .post('/api/upload')
        .set(auth)
        .attach('file', Buffer.from('# MySQL 文档'), 'mysql.md')
        .expect(202);
      await app.get(IndexingService).process(accepted.body.data.taskId);
      const docs = await request(app.getHttpServer()).get('/api/documents').set(auth).expect(200);
      expect(docs.body.data[0].uploadTime).toMatch(/^\d{4}-\d\d-\d\dT/);
      const response = await request(app.getHttpServer())
        .post('/api/stream-chat')
        .set(auth)
        .send({ question: '问题' })
        .expect(200);
      expect(response.text).toContain('持久化回答');
      const chats = await request(app.getHttpServer()).get('/api/chats').set(auth).expect(200);
      expect(chats.body.data[0].messages).toHaveLength(2);
      const id = chats.body.data[0].id;
      await request(app.getHttpServer()).delete(`/api/chats/${id}`).set(auth).expect(200);
      expect(await store.list('messages', { chatId: id })).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
