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
  c.EMBEDDING_PROVIDER ||= c.STORAGE_DRIVER === 'memory' ? 'local' : 'dashscope';
  if (!['local', 'dashscope'].includes(c.EMBEDDING_PROVIDER))
    throw new Error('Invalid EMBEDDING_PROVIDER');
  c.EMBEDDING_MODEL ||=
    c.EMBEDDING_PROVIDER === 'local' ? 'Xenova/all-MiniLM-L6-v2' : 'qwen3.7-text-embedding-flash';
  c.EMBEDDING_REVISION ||=
    c.EMBEDDING_PROVIDER === 'local' ? '6fa4bf687ce79106377b66d10009c0e513715e24' : 'api-v1';
  c.EMBEDDING_DIMENSIONS = Number(
    c.EMBEDDING_DIMENSIONS || (c.EMBEDDING_PROVIDER === 'local' ? 384 : 1024),
  );
  if (![64, 128, 256, 384, 512, 768, 1024, 1536, 2048].includes(c.EMBEDDING_DIMENSIONS))
    throw new Error('Invalid EMBEDDING_DIMENSIONS');
  if (c.EMBEDDING_PROVIDER === 'local' && c.EMBEDDING_DIMENSIONS !== 384)
    throw new Error('旧 MiniLM 模型仅支持 384 维');
  if (c.EMBEDDING_PROVIDER === 'dashscope' && c.EMBEDDING_DIMENSIONS === 384)
    throw new Error('远程 Embedding 模型不支持 384 维，请选择 1024 等受支持维度');
  if (c.EMBEDDING_PROVIDER === 'dashscope' &&
      c.EMBEDDING_MODEL === 'qwen3.7-text-embedding-flash' &&
      ![256, 512, 768, 1024].includes(c.EMBEDDING_DIMENSIONS))
    throw new Error('qwen3.7-text-embedding-flash 仅支持 256、512、768、1024 维');
  c.RERANK_MODEL ||= 'qwen3.7-text-rerank';
  c.EMBEDDING_BASE_URL ||= 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  c.EMBEDDING_TOKENIZER ||= c.STORAGE_DRIVER === 'memory' ? 'test:unicode-v1' : 'estimate:utf8-v1';
  c.CHAT_TOKENIZER ||= c.STORAGE_DRIVER === 'memory' ? 'test:unicode-v1' : 'estimate:utf8-v1';
  for (const key of ['EMBEDDING_BASE_URL']) {
    if (!['https:', 'http:'].includes(new URL(c[key]).protocol))
      throw new Error(key + ' must be HTTP(S)');
  }
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
  for (const [key, fallback] of Object.entries({
    CHAT_CONTEXT_TOKENS: 32768,
    CHAT_OUTPUT_TOKENS: 4096,
    RAG_EVIDENCE_TOKENS: 8000,
    RAG_HISTORY_TOKENS: 2048,
    QUERY_PLAN_TOKEN_BUDGET: 4096,
    QUALITY_MODEL_TIMEOUT_MS: 20000,
  })) {
    c[key] = Number(c[key] ?? fallback);
    if (!Number.isSafeInteger(c[key]) || c[key] < 1)
      throw new Error(key + ' must be a positive integer');
  }
  if (c.CHAT_CONTEXT_TOKENS <= c.CHAT_OUTPUT_TOKENS + 512)
    throw new Error('CHAT_CONTEXT_TOKENS must leave room for input and safety reserve');
  c.RERANK_MIN_SCORE = Number(c.RERANK_MIN_SCORE ?? 0);
  if (!Number.isFinite(c.RERANK_MIN_SCORE) || c.RERANK_MIN_SCORE < 0 || c.RERANK_MIN_SCORE > 1)
    throw new Error('RERANK_MIN_SCORE must be within [0,1]');
  return c;
}
