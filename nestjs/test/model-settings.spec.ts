import { ConfigService } from '@nestjs/config';
import { MemoryStore } from '../src/persistence/memory.store';
import { ModelSettingsService } from '../src/modules/model-settings/model-settings.service';
import { modelBinding, runWithModels, sealRuntimeModels, runWithTaskModels } from '../src/modules/model-settings/model-runtime';

function fixture() {
  const config = new ConfigService({ JWT_SECRET: 'model-settings-test-secret-32-characters', STORAGE_DRIVER: 'mysql',
    CHAT_BASE_URL: 'https://old.example/v1', CHAT_MODEL: 'old-chat', CHAT_API_KEY: 'server-chat-key',
    AGENT_MODEL: 'old-agent', VISION_MODEL: 'old-vision', VISION_BASE_URL: 'https://vision.example/v1',
    EMBEDDING_PROVIDER: 'dashscope', EMBEDDING_MODEL: 'old-embedding', EMBEDDING_DIMENSIONS: 1024,
    EMBEDDING_BASE_URL: 'https://old.example/v1', EMBEDDING_API_KEY: 'server-embedding-key',
    QUERY_PLAN_BASE_URL: 'https://old.example/v1', QUERY_PLAN_MODEL: 'old-planner',
    RERANK_MODEL: 'old-rerank' });
  const store = new MemoryStore();
  return { config, store, settings: new ModelSettingsService(store, config) };
}
const custom = { provider: 'siliconflow' as const, baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'BAAI/bge-m3', apiKey: 'private-account-key', dimensions: 1024, sendDimensions: false };

test('account settings persist encrypted, isolate users and never return credentials', async () => {
  const { settings, store, config } = fixture();
  await settings.save(1, 'embedding', custom);
  const restarted = new ModelSettingsService(store, config);
  const view = await restarted.list(1);
  expect(view.find(x => x.role === 'embedding')).toMatchObject({ model: 'BAAI/bge-m3', hasApiKey: true, source: 'custom', sendDimensions: false });
  expect((await restarted.list(2)).find(x => x.role === 'embedding')?.model).toBe('old-embedding');
  const rows = await store.list('modelSettings');
  expect(JSON.stringify(rows)).not.toContain('private-account-key');
  expect(JSON.stringify(view)).not.toContain('private-account-key');
  expect(JSON.stringify(view)).not.toContain('server-chat-key');
  expect(JSON.stringify(view)).not.toContain(rows[0].encryptedApiKey);
  expect((await restarted.resolveRuntime(1)).bindings.embedding.apiKey).toBe('private-account-key');
});

test('blank keys are retained only for the same normalized endpoint, including system defaults', async () => {
  const { settings } = fixture();
  await settings.save(1, 'chat', { provider: 'openai-compatible', model: 'new-chat', baseUrl: 'https://old.example/v1/' });
  expect((await settings.resolveRuntime(1)).bindings.chat.apiKey).toBe('server-chat-key');
  await expect(settings.save(1, 'chat', { provider: 'openai-compatible', model: 'new', baseUrl: 'https://other.example/v1', apiKey: '' })).rejects.toThrow('API Key');
  await settings.save(1, 'embedding', custom);
  await settings.save(1, 'embedding', { ...custom, model: 'another-model', apiKey: '' });
  expect((await settings.resolveRuntime(1)).bindings.embedding.apiKey).toBe('private-account-key');
  await expect(settings.save(1, 'embedding', { ...custom, baseUrl: 'https://api.siliconflow.cn/other', apiKey: '' })).rejects.toThrow('API Key');
});

test('reset restores environment settings and agent follows chat only until explicitly configured', async () => {
  const { settings } = fixture();
  await settings.save(1, 'chat', { ...custom, model: 'custom-chat' });
  let snapshot = await settings.resolveRuntime(1);
  expect(snapshot.bindings.agent).toMatchObject({ model: 'custom-chat', apiKey: 'private-account-key' });
  expect(snapshot.bindings.vision).toMatchObject({ model: 'old-vision', baseUrl: 'https://vision.example/v1' });
  await settings.save(1, 'agent', { ...custom, model: 'custom-agent' });
  expect((await settings.resolveRuntime(1)).bindings.agent.model).toBe('custom-agent');
  await settings.reset(1, 'agent');
  expect((await settings.resolveRuntime(1)).bindings.agent.model).toBe('custom-chat');
  await settings.reset(1, 'chat');
  snapshot = await settings.resolveRuntime(1);
  expect(snapshot.bindings.chat.model).toBe('old-chat');
  expect(snapshot.bindings.agent.model).toBe('old-agent');
});

test('invalid bindings are rejected before storage and BGE-M3 cannot send dimensions', async () => {
  const { settings, store } = fixture();
  for (const override of [{ model: ' ' }, { baseUrl: 'file:///secret' }, { baseUrl: 'https://user:pass@example.com' }, { dimensions: 0 }, { dimensions: 768 }, { sendDimensions: true }]) {
    await expect(settings.save(1, 'embedding', { ...custom, ...override })).rejects.toThrow();
  }
  await expect(settings.save(1, 'unknown' as any, custom)).rejects.toThrow();
  await expect(settings.save(1, 'rerank', { ...custom, provider: 'openai-compatible' })).rejects.toThrow();
  expect(await store.list('modelSettings')).toHaveLength(0);
});

test('concurrent request contexts isolate accounts and encrypted task snapshots survive later edits', async () => {
  const { settings, config } = fixture();
  await settings.save(1, 'chat', { ...custom, model: 'first' });
  await settings.save(2, 'chat', { ...custom, model: 'second', apiKey: 'other-account-key' });
  const first = await settings.resolveRuntime(1), second = await settings.resolveRuntime(2);
  const results = await Promise.all([first, second].map(snapshot => runWithModels(snapshot, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return modelBinding(config, 'chat').model;
  })));
  expect(results).toEqual(['first', 'second']);
  expect(modelBinding(config, 'chat').model).toBe('old-chat');
  const sealed = runWithModels(first, () => sealRuntimeModels(config));
  expect(sealed).not.toContain('private-account-key');
  await settings.save(1, 'chat', { ...custom, model: 'changed' });
  const task = { userId: 1, payload: { modelSnapshot: sealed } };
  expect(await runWithTaskModels(config, task, async () => modelBinding(config, 'chat').model)).toBe('first');
  await expect(runWithTaskModels(config, { ...task, userId: 2 }, async () => 'wrong')).rejects.toThrow();
  expect(await runWithTaskModels(config, { userId: 1, payload: {} }, async () => modelBinding(config, 'chat').model)).toBe('old-chat');
});

test('damaged credentials can be listed, replaced explicitly or reset without decrypting unrelated roles', async () => {
  const { settings, store } = fixture();
  await settings.save(1, 'chat', { ...custom, model: 'custom-chat' });
  await settings.save(1, 'embedding', custom);
  const rows = await store.list('modelSettings', { userId: 1 });
  for (const row of rows) await store.save('modelSettings', { id: row.id, encryptedApiKey: 'damaged' });
  await expect(settings.list(1)).resolves.toHaveLength(6);
  await expect(settings.save(1, 'chat', { ...custom, model: 'repaired-chat', apiKey: 'replacement-key' })).resolves.toMatchObject({ model: 'repaired-chat' });
  await expect(settings.reset(1, 'embedding')).resolves.toMatchObject({ source: 'system' });
  expect((await settings.resolveRuntime(1)).bindings.chat.apiKey).toBe('replacement-key');
});
