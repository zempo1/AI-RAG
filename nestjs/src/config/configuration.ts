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
  c.MAX_DOCUMENT_BYTES = Number(c.MAX_DOCUMENT_BYTES || 128 * 1024 * 1024);
  if (!Number.isSafeInteger(c.MAX_DOCUMENT_BYTES) || c.MAX_DOCUMENT_BYTES < 1)
    throw new Error('MAX_DOCUMENT_BYTES must be a positive integer');
  return c;
}
