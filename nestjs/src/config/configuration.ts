import { resolve } from 'node:path';

export function validateConfig(input: Record<string, unknown>): Record<string, any> {
  const c: Record<string, any> = { ...input };
  c.STORAGE_DRIVER = c.STORAGE_DRIVER || 'mysql';
  if (!['mysql', 'memory'].includes(c.STORAGE_DRIVER))
    throw new Error('STORAGE_DRIVER must be mysql or memory');
  for (const [key, fallback] of [
    ['PORT', 8080],
    ['DB_PORT', 3306],
  ] as const) {
    c[key] = Number(c[key] ?? fallback);
    if (!Number.isInteger(c[key]) || c[key] < 1 || c[key] > 65535)
      throw new Error(`${key} must be a valid port`);
  }
  if (c.STORAGE_DRIVER === 'mysql') {
    for (const key of ['DB_PASSWORD', 'DB_USER'])
      if (!c[key]) throw new Error(`${key} is required in mysql mode`);
  }
  if (typeof c.JWT_SECRET !== 'string' || c.JWT_SECRET.length < 32)
    throw new Error('JWT_SECRET must contain at least 32 characters');
  c.DB_HOST ||= '127.0.0.1';
  c.DB_NAME ||= 'ai_rag';
  c.DB_TIMEZONE ||= '+08:00';
  if (!/^(Z|[+-](0\d|1[0-4]):[0-5]\d)$/.test(c.DB_TIMEZONE))
    throw new Error('DB_TIMEZONE must be Z or ±HH:MM');
  c.CHAT_BASE_URL ||= 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const url = new URL(c.CHAT_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('CHAT_BASE_URL must be HTTP(S)');
  c.CHAT_MODEL ||= 'qwen3.8-flash';
  c.EMBEDDING_MODEL ||= 'Xenova/all-MiniLM-L6-v2';
  c.EMBEDDING_REVISION ||= '6fa4bf687ce79106377b66d10009c0e513715e24';
  c.MODEL_CACHE_DIR = resolve(c.MODEL_CACHE_DIR || '.cache/models');
  c.UPLOAD_TEMP_DIR = resolve(c.UPLOAD_TEMP_DIR || '.tmp/uploads');
  c.ORIGINALS_DIR = resolve(c.ORIGINALS_DIR || '.data/originals');
  c.VECTOR_DRIVER ||= c.STORAGE_DRIVER === 'memory' ? 'memory' : 'qdrant';
  c.QUEUE_DRIVER ||= c.STORAGE_DRIVER === 'memory' ? 'memory' : 'bullmq';
  if (!['memory', 'qdrant'].includes(c.VECTOR_DRIVER))
    throw new Error('VECTOR_DRIVER must be memory or qdrant');
  if (!['memory', 'bullmq'].includes(c.QUEUE_DRIVER))
    throw new Error('QUEUE_DRIVER must be memory or bullmq');
  if (c.STORAGE_DRIVER === 'memory' && c.QUEUE_DRIVER !== 'memory')
    throw new Error('内存数据不能跨 API/Worker 共享，请使用 QUEUE_DRIVER=memory');
  c.QDRANT_URL ||= 'http://127.0.0.1:6333';
  c.QDRANT_COLLECTION ||= 'rag';
  c.REDIS_URL ||= 'redis://127.0.0.1:6379';
  c.QUEUE_PREFIX ||= 'ai-rag';
  c.INDEX_RETENTION_MS = Number(c.INDEX_RETENTION_MS ?? 600000);
  if (!Number.isSafeInteger(c.INDEX_RETENTION_MS) || c.INDEX_RETENTION_MS < 0)
    throw new Error('INDEX_RETENTION_MS must be a nonnegative integer');
  for (const key of ['QDRANT_URL', 'REDIS_URL']) {
    const protocol = new URL(c[key]).protocol;
    if (!(key === 'REDIS_URL' ? ['redis:', 'rediss:'] : ['http:', 'https:']).includes(protocol))
      throw new Error(key + ' 协议无效');
  }
  c.MAX_DOCUMENT_BYTES = Number(c.MAX_DOCUMENT_BYTES || 128 * 1024 * 1024);
  if (!Number.isSafeInteger(c.MAX_DOCUMENT_BYTES) || c.MAX_DOCUMENT_BYTES < 1)
    throw new Error('MAX_DOCUMENT_BYTES must be a positive integer');
  return c;
}
