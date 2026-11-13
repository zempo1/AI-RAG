import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/api-error';

export const MODEL_ROLES = ['chat', 'agent', 'vision', 'queryPlan', 'embedding', 'rerank'] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export type ModelProvider = 'local' | 'dashscope' | 'siliconflow' | 'openai-compatible';
export interface ModelBinding {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimensions?: number;
  sendDimensions?: boolean;
  custom?: boolean;
}
export interface ModelRuntimeSnapshot {
  userId: number;
  bindings: Record<ModelRole, ModelBinding>;
}
const runtime = new AsyncLocalStorage<ModelRuntimeSnapshot | undefined>();
export const currentModels = () => runtime.getStore();
export function runWithModels<T>(snapshot: ModelRuntimeSnapshot | undefined, work: () => T): T {
  if (snapshot) {
    for (const binding of Object.values(snapshot.bindings)) Object.freeze(binding);
    Object.freeze(snapshot.bindings);
    Object.freeze(snapshot);
  }
  return runtime.run(snapshot, work);
}
export function normalizedModelUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new ApiError(400, 'API 地址必须是无认证信息、查询参数和片段的 HTTP(S) 地址');
  return url.toString().replace(/\/+$/, '');
}

/** Each environment binding is resolved as a unit; secrets never inherit across a custom URL. */
export function environmentBindings(config: ConfigService): Record<ModelRole, ModelBinding> {
  const chat: ModelBinding = { provider: 'openai-compatible',
    baseUrl: config.get('CHAT_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: config.get('CHAT_MODEL') || 'qwen3.8-flash', apiKey: config.get('CHAT_API_KEY') || undefined };
  return {
    chat,
    agent: { ...chat, model: config.get('AGENT_MODEL') || chat.model },
    vision: { ...chat, baseUrl: config.get('VISION_BASE_URL') || chat.baseUrl,
      model: config.get('VISION_MODEL') || 'qwen3.8-flash', apiKey: config.get('VISION_API_KEY') || chat.apiKey },
    queryPlan: { ...chat, baseUrl: config.get('QUERY_PLAN_BASE_URL') || chat.baseUrl,
      model: config.get('QUERY_PLAN_MODEL') || chat.model, apiKey: config.get('QUERY_PLAN_API_KEY') || chat.apiKey },
    embedding: { provider: config.get('EMBEDDING_PROVIDER') || (config.get('STORAGE_DRIVER') === 'memory' ? 'local' : 'dashscope'),
      baseUrl: config.get('EMBEDDING_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: config.get('EMBEDDING_MODEL') || (config.get('STORAGE_DRIVER') === 'memory' ? 'Xenova/all-MiniLM-L6-v2' : 'qwen3.7-text-embedding-flash'),
      apiKey: config.get('EMBEDDING_API_KEY') || chat.apiKey,
      dimensions: Number(config.get('EMBEDDING_DIMENSIONS') || (config.get('STORAGE_DRIVER') === 'memory' ? 384 : 1024)), sendDimensions: true },
    rerank: { provider: 'dashscope', model: config.get('RERANK_MODEL') || 'qwen3.7-text-rerank',
      baseUrl: config.get('RERANK_URL') || 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
      apiKey: config.get('RERANK_API_KEY') || chat.apiKey },
  };
}
export function modelBinding(config: ConfigService, role: ModelRole): ModelBinding {
  return currentModels()?.bindings[role] || environmentBindings(config)[role];
}
export function bindingIdentity(binding: ModelBinding) {
  return createHash('sha256').update(JSON.stringify({ provider: binding.provider,
    baseUrl: binding.baseUrl, model: binding.model, dimensions: binding.dimensions,
    sendDimensions: binding.sendDimensions })).digest('hex');
}

/** Some providers echo the rejected key in errors; do not forward their raw error object. */
export function redactModelError(config: ConfigService, error: unknown, requestKey?: string): unknown {
  const keys = new Set([...Object.values(currentModels()?.bindings || environmentBindings(config)).map(b => b.apiKey), requestKey].filter((key): key is string => !!key));
  const message = error instanceof Error ? error.message : String(error);
  let safe = message;
  for (const key of keys) safe = safe.split(key).join('[已隐藏]');
  if (safe === message) return error;
  return error instanceof ApiError ? new ApiError(error.getStatus(), safe) : new Error(safe);
}

function encryptionKey(config: ConfigService, purpose: string) {
  return createHash('sha256').update(config.getOrThrow<string>('JWT_SECRET') + '/model-settings/' + purpose).digest();
}
export function encryptModelSecret(config: ConfigService, value: string, purpose: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(config, purpose), iv);
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(b => b.toString('base64')).join('.');
}
export function decryptModelSecret(config: ConfigService, value: string, purpose: string) {
  try {
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error();
    const [iv, tag, bytes] = parts.map(s => Buffer.from(s, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey(config, purpose), iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8');
  } catch { throw new ApiError(503, '模型凭据无法解密，请重新保存对应模型设置'); }
}
export function sealRuntimeModels(config: ConfigService): string | null {
  const snapshot = currentModels();
  return snapshot ? encryptModelSecret(config, JSON.stringify(snapshot), 'task-snapshot') : null;
}
export async function runWithTaskModels<T>(config: ConfigService, task: { userId: number; payload?: any }, work: () => Promise<T>): Promise<T> {
  const sealed = task.payload?.modelSnapshot;
  const snapshot: ModelRuntimeSnapshot | undefined = sealed
    ? JSON.parse(decryptModelSecret(config, sealed, 'task-snapshot')) : undefined;
  if (snapshot && (snapshot.userId !== task.userId || !MODEL_ROLES.every(role => snapshot.bindings?.[role])))
    throw new ApiError(409, '任务模型配置与账号不匹配');
  return runWithModels(snapshot, work);
}
