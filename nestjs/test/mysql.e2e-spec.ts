import { agentLlmFixture } from './helpers/agent-llm.fixture';
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
import { ConfigService } from '@nestjs/config';
import { AgentService } from '../src/modules/agent/agent.service';
import { MysqlAgentCheckpointer } from '../src/modules/agent/mysql-agent-checkpointer';
import { AgentQaTasksService } from '../src/modules/tasks/agent-qa.service';
import { ModelSettingsService } from '../src/modules/model-settings/model-settings.service';
import { ModelSettings1794355200000 } from '../src/persistence/migrations/1794355200000-model-settings';
import { HistoryService } from '../src/modules/history/history.service';
import { KnowledgeBasesService } from '../src/modules/knowledge-bases/knowledge-bases.service';
import type { ModelExecutionOptions } from '../src/modules/llm/llm.types';
import { emptyCheckpoint } from '@langchain/langgraph';
import { ERROR } from '@langchain/langgraph-checkpoint';

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
  it('persists account models across database reconnects and applies the additive upgrade idempotently', async () => {
    const runner = source.createQueryRunner();
    try { await new ModelSettings1794355200000().up(runner); await new ModelSettings1794355200000().up(runner); }
    finally { await runner.release(); }
    const user = await store.save('users', { username: 'model-settings-mysql', password: 'hash' });
    const config = new ConfigService({ JWT_SECRET: 'mysql-model-setting-secret-32-characters' });
    await new ModelSettingsService(store, config).save(user.id, 'embedding', { provider: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', apiKey: 'mysql-private-key', dimensions: 1024, sendDimensions: false });
    const [raw] = await source.query('SELECT encrypted_api_key, binding FROM user_model_settings WHERE user_id = ?', [user.id]);
    expect(JSON.stringify(raw)).not.toContain('mysql-private-key');
    await source.destroy(); await source.initialize(); store = new MysqlStore(source.manager);
    const service = new ModelSettingsService(store, config);
    expect((await service.resolveRuntime(user.id)).bindings.embedding.apiKey).toBe('mysql-private-key');
    expect((await service.list(user.id)).find(r => r.role === 'embedding')).toMatchObject({ model: 'BAAI/bge-m3', source: 'custom', hasApiKey: true });
    await service.reset(user.id, 'embedding');
    expect(await store.list('modelSettings', { userId: user.id })).toHaveLength(0);
    await store.delete('users', user.id);
  });

  it('serializes a document vector lease across sessions without blocking other documents', async () => {
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = store.withDocumentVectorLock(123, async () => {
      entered();
      await gate;
    });
    await writing;
    let ran = false;
    const contender = new MysqlStore(source.manager).withDocumentVectorLock(123, async () => {
      ran = true;
    });
    try {
      const independent = await store.withDocumentVectorLock(124, async () => 'ready');
      expect(independent).toBe('ready');
      expect(ran).toBe(false);
    } finally {
      release();
      await Promise.all([original, contender]);
    }
    expect(ran).toBe(true);
  });

  it('resumes a MySQL Agent thread after reconnect and rejects stale writes during retry', async () => {
    const user = await store.save('users', { username: 'graph-reconnect', password: 'hash' });
    const kb = await new KnowledgeBasesService(store).default(user.id);
    const settings = {
      AGENT_SYNC_MS: 30000, JWT_SECRET: 'test-secret-for-agent-graph',
    };
    const config = new ConfigService(settings);
    const scope = { userId: user.id, knowledgeBaseId: kb.id, documents: [] };
    const retrieval = {
      createScope: async () => scope,
      verify: async () => {},
      pack: async () => ({ sources: [], complete: false }),
      context: () => '',
    };
    let planned = 0, decisions = 0;
    let checkStaleOwner: () => Promise<void>;
    const llm = {
      complete: async (prompt: string, _key: string, _history: unknown, _signal: AbortSignal, options: ModelExecutionOptions) => {
        planned++;
        const reservation = await options.observer!.before({ kind: 'complete', model: 'test', input: prompt, maxOutputTokens: 64 });
        await options.observer!.settle(reservation, { status: 'success', usage: { totalTokens: 40 } });
        settings.AGENT_SYNC_MS = 1;
        return '{"intent":"search","complexity":"simple","subQuestions":["问题"],"ambiguous":false}';
      },
      invokeTools: async (_messages: unknown, _definitions: unknown, options: ModelExecutionOptions) => {
        await checkStaleOwner();
        const reservation = await options.observer!.before({ kind: 'tools', model: 'test', input: '证据', maxOutputTokens: 64 });
        if (++decisions === 1) throw new Error('模拟调用发出后进程退出：test-runtime-key');
        await options.observer!.settle(reservation, { status: 'success', usage: { totalTokens: 30 } });
        return { content: '', toolCalls: [] };
      },
    };
    const makeWorker = () => {
      const libraries = new KnowledgeBasesService(store);
      const agent = new AgentService(retrieval as any, llm as any, {} as any, config, store);
      return { agent, tasks: new AgentQaTasksService(store, new HistoryService(store, libraries), libraries, agent, config) };
    };
    const foreground = makeWorker();
    const started = await foreground.tasks.begin(user.id, {
      question: '问题', knowledgeBaseId: kb.id, requestId: 'resume', fingerprint: 'resume', apiKey: 'test-runtime-key',
    });
    const id = started.task.id;
    const threadId = `qa:${id}:v2`;
    const execution = foreground.tasks.execution(id, started.token!);
    const stale = new MysqlAgentCheckpointer(store, execution.graphOwner);
    try {
      const prepared = await foreground.agent.prepare('问题', user.id, kb.id, {
        ...execution, chatId: started.chat.id, apiKey: 'test-runtime-key',
      });
      expect(prepared.requiresAsync).toBe(true);
      const saved = (await stale.getTuple({ configurable: { thread_id: threadId } }))!;
      const history = [];
      for await (const checkpoint of stale.list({ configurable: { thread_id: threadId } })) history.push(checkpoint);
      expect(history.length).toBeGreaterThan(1);
      expect(JSON.stringify(history)).not.toContain('test-runtime-key');
      expect(JSON.stringify(history)).not.toContain(started.token);
      checkStaleOwner = async () => {
        await expect(stale.put(saved.config, saved.checkpoint, saved.metadata!)).rejects.toThrow('执行权');
        await expect(stale.putWrites(saved.config, [['out', 'stale']], 'stale')).rejects.toThrow('执行权');
      };
      await foreground.tasks.handoff(id, started.token!);
    } finally {
      execution.dispose();
    }
    expect((await store.get('tasks', id))?.payload.agentBudgetLedger.budget.calls).toBe(1);
    await source.destroy();
    await source.initialize();
    store = new MysqlStore(source.manager);
    await expect(makeWorker().tasks.process(id)).rejects.toThrow('模拟调用发出后进程退出');
    const retrying = (await store.get('tasks', id))!;
    expect(retrying.status).toBe('retrying');
    expect(retrying.payload.snapshot).toBeUndefined();
    expect(retrying.payload.agentBudgetLedger.budget).toMatchObject({ calls: 2, tokens: 110 });
    const errors = (await store.list('agentCheckpointWrites', { threadId, channel: ERROR }))
      .map(write => Buffer.from(write.value.split(':')[1], 'base64').toString('utf8'));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join()).not.toContain('test-runtime-key');
    await source.destroy();
    await source.initialize();
    store = new MysqlStore(source.manager);
    expect(await makeWorker().tasks.process(id, 2)).toBe('done');
    expect({ planned, decisions }).toEqual({ planned: 1, decisions: 2 });
    const finished = (await store.get('tasks', id))!;
    expect(finished.payload.agentProgress.budget).toMatchObject({ calls: 3, tokens: 140 });
    expect((await store.list('messages', { chatId: started.chat.id })).filter(row => row.role === 'assistant')).toHaveLength(1);
    expect(await store.list('agentCheckpoints', { threadId })).toEqual([]);
    expect(await store.list('agentCheckpointWrites', { threadId })).toEqual([]);
  });

  it('replays only the failed tool in a batch and rechecks the frozen revision at commit', async () => {
    const user = await store.save('users', { username: 'graph-tools', password: 'hash' });
    const libraries = new KnowledgeBasesService(store);
    const kb = await libraries.default(user.id);
    const doc = await store.save('documents', { userId: user.id, knowledgeBaseId: kb.id, filename: '原文.md' });
    const version = await store.save('versions', { documentId: doc.id, filename: doc.filename });
    const revision = await store.save('indexRevisions', {
      documentId: doc.id, versionId: version.id, embeddingFingerprint: 'test', status: 'active',
    });
    await store.save('documents', { id: doc.id, activeIndexRevisionId: revision.id });
    const scope = {
      userId: user.id, knowledgeBaseId: kb.id,
      documents: [{ documentId: doc.id, filename: doc.filename, indexRevisionId: revision.id }],
    };
    let searches = 0, reads = 0, decisions = 0, scopes = 0;
    const retrieval = {
      createScope: async () => { scopes++; return scope; },
      verify: async () => {},
      open: async () => ({}),
      search: async () => { searches++; return { evidence: [] }; },
      read: async () => {
        if (++reads === 1) throw new Error('摘要工具暂时离线');
        return { evidence: [], complete: false };
      },
      pack: async () => ({ sources: [], complete: false }),
      context: () => '',
    };
    const llm = {
      complete: async () => '{"intent":"search","complexity":"simple","subQuestions":["问题"],"ambiguous":false}',
      invokeTools: async () => ({
        content: '',
        toolCalls: ++decisions === 1 ? [
          { id: 'summary', name: 'summarize_document', args: { documentId: doc.id } },
          { id: 'search', name: 'keyword_search', args: { query: '问题' } },
        ] : [],
      }),
    };
    const summary = { summarizeAgent: async () => ({ groups: [], coverage: { complete: false } }) };
    const config = new ConfigService({ JWT_SECRET: 'test-secret-for-agent-graph' });
    const agent = new AgentService(retrieval as any, llm as any, summary as any, config, store);
    const tasks = new AgentQaTasksService(store, new HistoryService(store, libraries), libraries, agent, config);
    const started = await tasks.begin(user.id, { question: '问题', requestId: 'tool-batch', fingerprint: 'tool-batch' });
    const id = started.task.id;
    const execution = tasks.execution(id, started.token!);
    try {
      await expect(agent.prepare('问题', user.id, kb.id, {
        ...execution, background: true, chatId: started.chat.id,
      })).rejects.toThrow('摘要工具暂时离线');
    } finally {
      execution.dispose();
    }
    expect({ searches, reads }).toEqual({ searches: 1, reads: 1 });
    const restartedAgent = new AgentService(retrieval as any, llm as any, summary as any, config, store);
    const restartedTasks = new AgentQaTasksService(store, new HistoryService(store, libraries), libraries, restartedAgent, config);
    const retryToken = 'renewed-token';
    await store.transaction(async tx => {
      await tx.lock('knowledgeBases', kb.id);
      const task = (await tx.lock('tasks', id))!;
      await tx.save('tasks', { id, executionToken: retryToken, payload: { ...task.payload, foreground: false } });
    });
    const retry = restartedTasks.execution(id, retryToken);
    try {
      const context = await restartedAgent.prepare('问题', user.id, kb.id, {
        ...retry, background: true, chatId: started.chat.id,
      });
      const answer = await restartedAgent.answerPrepared(context);
      expect({ searches, reads, decisions, scopes }).toEqual({ searches: 1, reads: 2, decisions: 2, scopes: 1 });
      const progress = (await store.get('tasks', id))?.payload.agentProgress;
      expect(progress.steps.filter((step: { kind: string }) => step.kind === 'tool_start')).toHaveLength(2);
      let completion!: Promise<unknown>;
      await store.transaction(async tx => {
        await tx.lock('knowledgeBases', kb.id);
        await tx.lock('documents', doc.id);
        completion = expect(restartedTasks.complete(id, retryToken, answer)).rejects.toThrow('索引已更新');
        await tx.save('documents', { id: doc.id, activeIndexRevisionId: null });
      });
      await completion;
      const threadId = `qa:${id}:v2`;
      expect(await store.list('agentCheckpoints', { threadId })).not.toHaveLength(0);
      await restartedTasks.cancel(id, user.id);
      await expect(restartedTasks.complete(id, retryToken, answer)).rejects.toThrow('执行权');
      expect(await store.list('agentCheckpoints', { threadId })).toEqual([]);
      const messages = (await store.list('messages', { chatId: started.chat.id })).filter(row => row.role === 'assistant');
      expect(messages).toHaveLength(1);
      expect(messages[0].generationStatus).toBe('interrupted');
    } finally {
      retry.dispose();
    }
  });

  it('cleans revoked native checkpoints when the chat has been deleted', async () => {
    const user = await store.save('users', { username: 'graph-deleted-chat', password: 'hash' });
    const libraries = new KnowledgeBasesService(store);
    const history = new HistoryService(store, libraries);
    const config = new ConfigService({ JWT_SECRET: 'test-secret-for-agent-graph' });
    const agent = new AgentService({} as any, {} as any, {} as any, config, store);
    const tasks = new AgentQaTasksService(store, history, libraries, agent, config);
    const started = await tasks.begin(user.id, { question: '问题', requestId: 'deleted-chat', fingerprint: 'deleted-chat' });
    const id = started.task.id;
    const threadId = `qa:${id}:v2`;
    const saver = new MysqlAgentCheckpointer(store, { taskId: id, token: started.token! });
    await saver.put({ configurable: { thread_id: threadId } }, emptyCheckpoint(), { source: 'input', step: -1, parents: {} });
    await history.delete(started.chat.id, user.id);
    await tasks.fail(id, started.token!, new Error('中断'));
    expect(await store.get('tasks', id)).toMatchObject({ status: 'failed', retryable: 0, executionToken: null });
    expect(await store.list('agentCheckpoints', { threadId })).toEqual([]);
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
    expect(await store.list('messages', { chatId: chat.id })).toEqual([]);
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

  it('boots the complete MySQL-backed app and persists the upload and native Agent SSE flow', async () => {
    process.env.STORAGE_DRIVER = 'mysql';
    process.env.AGENT_SYNC_MS = '30000';
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
      .useValue(agentLlmFixture({
        complete: async () => '持久化回答',
        stream: async function* () {
          yield '持久化回答';
        },
      }))
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
      const [qa] = await store.list('tasks', { userId: userBefore.id, kind: 'qa' });
      expect(qa.payload).toMatchObject({ graphVersion: 2, graphThreadId: `qa:${qa.id}:v2` });
      expect(qa.payload.snapshot).toBeUndefined();
      await request(app.getHttpServer()).delete(`/api/chats/${id}`).set(auth).expect(200);
      expect(await store.list('messages', { chatId: id })).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
