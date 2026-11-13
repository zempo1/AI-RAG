import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { MemoryStore } from '../src/persistence/memory.store';
import { ModelSettingsService } from '../src/modules/model-settings/model-settings.service';
import { runWithModels } from '../src/modules/model-settings/model-runtime';
import { LlmService } from '../src/modules/llm/llm.service';
import { QualityModelsService } from '../src/modules/rag/quality-models.service';
import { EmbeddingsService } from '../src/modules/embeddings/embeddings.service';
import { RetrievalService } from '../src/modules/rag/retrieval.service';
import { KnowledgeBasesService } from '../src/modules/knowledge-bases/knowledge-bases.service';
import { InMemoryVectorStore } from '../src/modules/vector-store/in-memory-vector-store.service';
import { currentModelProfile } from '../src/modules/embeddings/model-profile';
import { AgentService } from '../src/modules/agent/agent.service';
import { agentLlmFixture } from './helpers/agent-llm.fixture';

let server: Server, base: string;
const calls: { url: string; auth?: string; body: any }[] = [];
let badDimensions = false;
let echoCredential = false;
let invalidJson = false;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ url: req.url!, auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (invalidJson) { res.end('private-key'); return; }
    if (echoCredential) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'invalid key: ' + req.headers.authorization } })); return; }
    if (req.url?.endsWith('/embeddings')) {
      res.end(JSON.stringify({ data: body.input.map((_: string, index: number) => ({ index, embedding: Array(badDimensions ? 768 : 1024).fill(0.1) })) }));
    } else if (req.url?.includes('rerank')) res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }));
    else if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '切换成功' }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n');
    } else res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: req.url?.includes('planner')
        ? JSON.stringify({ query: '问题', keywords: [], mode: 'search', documentIds: [], ambiguous: false, route: 'document' }) : '切换成功' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { calls.length = 0; badDimensions = false; echoCredential = false; invalidJson = false; });
function fixture() {
  const store = new MemoryStore();
  const config = new ConfigService({ JWT_SECRET: 'routing-fixture-secret-32-characters', STORAGE_DRIVER: 'mysql',
    CHAT_API_KEY: 'old-server-key', CHAT_MODEL: 'old-model', CHAT_BASE_URL: 'http://127.0.0.1:1/v1',
    EMBEDDING_TOKENIZER: 'estimate:utf8-v1', EMBEDDING_MODEL: 'old-embedding', EMBEDDING_PROVIDER: 'dashscope',
    EMBEDDING_DIMENSIONS: 1024, EMBEDDING_BASE_URL: 'http://127.0.0.1:1/v1' });
  return { config, store, settings: new ModelSettingsService(store, config), llm: new LlmService(config),
    quality: new QualityModelsService(config), embeddings: new EmbeddingsService(config) };
}

test('all six roles send their own endpoint, model and account credential, including stream and tools', async () => {
  const p = fixture();
  for (const [role, prefix] of [['chat', 'chat'], ['agent', 'agent'], ['vision', 'vision'], ['queryPlan', 'planner'], ['embedding', 'embedding'], ['rerank', 'rerank']] as const) {
    await p.settings.save(1, role, { provider: 'siliconflow', baseUrl: `${base}/${prefix}/v1${role === 'rerank' ? '/rerank' : ''}`,
      model: role === 'embedding' ? 'BAAI/bge-m3' : `${role}-model`, apiKey: `${role}-key`, dimensions: 1024, sendDimensions: false });
  }
  await runWithModels(await p.settings.resolveRuntime(1), async () => {
    expect(await p.llm.complete('问题', 'stale-browser-key')).toBe('切换成功');
    expect(calls.at(-1)).toMatchObject({ url: '/chat/v1/chat/completions', auth: 'Bearer chat-key', body: { model: 'chat-model' } });
    const chunks: string[] = [];
    for await (const chunk of p.llm.stream('问题')) chunks.push(chunk);
    expect(chunks.join('')).toBe('切换成功');
    await p.llm.invokeTools([{ role: 'user', content: '规划' }], [], { role: 'agent', model: 'stale-env-agent' });
    expect(calls.at(-1)).toMatchObject({ url: '/agent/v1/chat/completions', auth: 'Bearer agent-key', body: { model: 'agent-model' } });
    await p.llm.complete('图片', 'stale-key', [{ label: '第1页', dataUrl: 'data:image/png;base64,aGVsbG8=' }]);
    expect(calls.at(-1)).toMatchObject({ url: '/vision/v1/chat/completions', auth: 'Bearer vision-key', body: { model: 'vision-model' } });
    expect(await p.quality.plan('问题', [], [])).toMatchObject({ query: '问题' });
    expect(calls.at(-1)).toMatchObject({ url: '/planner/v1/chat/completions', auth: 'Bearer queryPlan-key', body: { model: 'queryPlan-model' } });
    expect(await p.embeddings.embedQuery('问题')).toHaveLength(1024);
    expect(calls.at(-1)).toMatchObject({ url: '/embedding/v1/embeddings', auth: 'Bearer embedding-key', body: { model: 'BAAI/bge-m3' } });
    expect(calls.at(-1)!.body).not.toHaveProperty('dimensions');
    expect(await p.quality.rerank('问题', ['原文'])).toEqual([{ index: 0, score: 0.9 }]);
    expect(calls.at(-1)).toMatchObject({ url: '/rerank/v1/rerank', auth: 'Bearer rerank-key', body: { model: 'rerank-model', query: '问题', documents: ['原文'] } });
    expect(calls.at(-1)!.body).not.toHaveProperty('input');
  });
});

test('DashScope rerank keeps its nested wire format and embedding verifies actual output dimensions', async () => {
  const p = fixture();
  await p.settings.save(1, 'rerank', { provider: 'dashscope', baseUrl: `${base}/dash-rerank`, model: 'qwen3.7-text-rerank', apiKey: 'rank-key' });
  await p.settings.save(1, 'embedding', { provider: 'siliconflow', baseUrl: base, model: 'BAAI/bge-m3', apiKey: 'embed-key', dimensions: 1024, sendDimensions: false });
  await runWithModels(await p.settings.resolveRuntime(1), async () => {
    await p.quality.rerank('问题', ['原文']);
    expect(calls.at(-1)!.body).toMatchObject({ model: 'qwen3.7-text-rerank', input: { query: '问题', documents: ['原文'] }, parameters: { top_n: 1 } });
    badDimensions = true;
    await expect(p.embeddings.embedQuery('问题')).rejects.toThrow('embedding response');
  });
});

test('incompatible indexes fail explicitly before hybrid fallback, while key rotation remains compatible', async () => {
  const p = fixture(), libraries = new KnowledgeBasesService(p.store);
  const kb = await libraries.resolve(1);
  await p.settings.save(1, 'embedding', { provider: 'siliconflow', baseUrl: base, model: 'BAAI/bge-m3', apiKey: 'old-key', dimensions: 1024, sendDimensions: false });
  const snapshot = await p.settings.resolveRuntime(1);
  const profile = runWithModels(snapshot, () => currentModelProfile(p.config));
  const revision = await p.store.save('indexRevisions', { documentId: 1, modelProfile: profile, status: 'active' });
  await p.store.save('documents', { id: 1, userId: 1, knowledgeBaseId: kb.id, activeIndexRevisionId: revision.id, filename: 'a.md', content: '原文' });
  const retrieval = new RetrievalService(p.embeddings, new InMemoryVectorStore(), p.store, libraries, undefined, p.quality, p.config);
  const scope = await retrieval.createScope(1, kb.id);
  await p.settings.save(1, 'embedding', { provider: 'siliconflow', baseUrl: base, model: 'BAAI/bge-m3', apiKey: 'rotated-key', dimensions: 1024, sendDimensions: false });
  await runWithModels(await p.settings.resolveRuntime(1), async () => { await expect(retrieval.open(scope)).resolves.toBeDefined(); });
  await p.settings.save(1, 'embedding', { provider: 'siliconflow', baseUrl: base, model: 'new-model', dimensions: 1024, sendDimensions: false });
  await runWithModels(await p.settings.resolveRuntime(1), async () => {
    await expect(retrieval.search(await retrieval.open(scope), '问题')).rejects.toThrow('向量模型已变更，请重建索引');
  });
  expect(calls).toHaveLength(0);
});

test('an old profile without a stored URL is compared with the environment URL, not the new account URL', async () => {
  const p = fixture(), libraries = new KnowledgeBasesService(p.store);
  const kb = await libraries.resolve(1);
  const old = currentModelProfile(p.config);
  const revision = await p.store.save('indexRevisions', { documentId: 1, modelProfile: old, status: 'active' });
  await p.store.save('documents', { id: 1, userId: 1, knowledgeBaseId: kb.id, activeIndexRevisionId: revision.id, filename: 'old.md' });
  await p.settings.save(1, 'embedding', { provider: 'openai-compatible', baseUrl: base, model: 'old-embedding', apiKey: 'new-host-key', dimensions: 1024, sendDimensions: true });
  const retrieval = new RetrievalService(p.embeddings, new InMemoryVectorStore(), p.store, libraries, undefined, p.quality, p.config);
  await runWithModels(await p.settings.resolveRuntime(1), async () => {
    await expect(retrieval.search(await retrieval.open(await retrieval.createScope(1, kb.id)), '问题')).rejects.toThrow('向量模型已变更');
  });
});

test('provider errors that echo a credential are redacted before reaching the caller or observer', async () => {
  const p = fixture();
  await p.settings.save(1, 'chat', { provider: 'openai-compatible', baseUrl: base, model: 'chat', apiKey: 'secret-that-provider-echoes' });
  echoCredential = true;
  await runWithModels(await p.settings.resolveRuntime(1), async () => {
    let observed: unknown, caught: unknown;
    try { await p.llm.complete('问题', undefined, [], undefined, { observer: {
      before: async () => 'reservation', settle: async (_id, outcome) => { observed = outcome.error; },
    } }); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect(String(caught)).not.toContain('secret-that-provider-echoes');
    expect(String(observed)).not.toContain('secret-that-provider-echoes');
  });
});

test.each(['embedding', 'queryPlan', 'rerank'] as const)('malformed %s JSON is redacted even on HTTP 200 responses', async role => {
  const p = fixture();
  await p.settings.save(1, role, { provider: 'siliconflow', baseUrl: `${base}/${role === 'rerank' ? 'rerank' : 'v1'}`,
    model: role === 'embedding' ? 'BAAI/bge-m3' : 'model', apiKey: 'private-key', dimensions: 1024, sendDimensions: false });
  invalidJson = true;
  await runWithModels(await p.settings.resolveRuntime(1), async () => {
    let caught: unknown;
    try {
      if (role === 'embedding') await p.embeddings.embedQuery('问题');
      else if (role === 'queryPlan') await p.quality.plan('问题', [], []);
      else await p.quality.rerank('问题', ['原文']);
    } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect(String(caught)).not.toContain('private-key');
  });
});

test('an incompatible unrelated document does not block a narrowed search or general Agent answer', async () => {
  const p = fixture(), libraries = new KnowledgeBasesService(p.store);
  const kb = await libraries.resolve(1), old = currentModelProfile(p.config);
  await p.settings.save(1, 'embedding', { provider: 'siliconflow', baseUrl: base, model: 'BAAI/bge-m3', apiKey: 'key', dimensions: 1024, sendDimensions: false });
  const runtime = await p.settings.resolveRuntime(1), profile = runWithModels(runtime, () => currentModelProfile(p.config));
  for (const [id, modelProfile] of [[1, profile], [2, old]] as const) {
    const revision = await p.store.save('indexRevisions', { documentId: id, modelProfile, status: 'active' });
    await p.store.save('documents', { id, userId: 1, knowledgeBaseId: kb.id, activeIndexRevisionId: revision.id, filename: `${id}.md`, content: '原文' });
  }
  const retrieval = new RetrievalService(p.embeddings, new InMemoryVectorStore(), p.store, libraries, undefined, p.quality, p.config);
  const offline = agentLlmFixture({ complete: async () => '通用问题回答', stream: async function* () { yield '通用问题回答'; } });
  const agent = new AgentService(retrieval, offline as any, {} as any, p.config, p.store);
  await runWithModels(runtime, async () => {
    const scope = await retrieval.createScope(1, kb.id);
    const narrowed = await retrieval.open(scope, [1]);
    await expect(retrieval.search(narrowed, '问题', { strategy: 'keyword' })).resolves.toBeDefined();
    const prepared = await agent.prepare('解释一下计算机网络', 1, kb.id, { mode: 'general' });
    expect((await agent.answerPrepared(prepared)).answer).toBe('通用问题回答');
    await expect(agent.prepare('在旧文档中查找问题', 1, kb.id, { mode: 'search', documentIds: [2] })).rejects.toThrow('向量模型已变更');
  });
});
