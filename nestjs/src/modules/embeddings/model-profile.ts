import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface ModelProfile {
  provider: 'local' | 'dashscope';
  model: string;
  revision: string;
  dimensions: number;
  tokenizer: string;
  chunkingVersion: string;
  tokenizerDigest?: string;
}
export function tokenizerDigest(tokenizer: string): string | undefined {
  if (!isAbsolute(tokenizer) || !existsSync(tokenizer)) return undefined;
  const file = statSync(tokenizer).isDirectory() ? join(tokenizer, 'tokenizer.json') : tokenizer;
  return existsSync(file)
    ? createHash('sha256').update(readFileSync(file)).digest('hex')
    : undefined;
}
export function assertTokenizerProfile(profile: ModelProfile) {
  if (profile.tokenizerDigest && tokenizerDigest(profile.tokenizer) !== profile.tokenizerDigest)
    throw new Error('Tokenizer 文件与索引模型配置不匹配，请恢复对应版本或重建索引');
}
const LEGACY_MODEL = 'Xenova/all-MiniLM-L6-v2';
const LEGACY_REVISION = '6fa4bf687ce79106377b66d10009c0e513715e24';
export function legacyModelProfile(_config?: ConfigService): ModelProfile {
  return {
    provider: 'local',
    model: LEGACY_MODEL,
    revision: LEGACY_REVISION,
    dimensions: 384,
    tokenizer: LEGACY_MODEL,
    chunkingVersion: 'legacy',
  };
}
export function currentModelProfile(config: ConfigService): ModelProfile {
  const provider =
    config.get('EMBEDDING_PROVIDER') ||
    (config.get('STORAGE_DRIVER') === 'memory' ? 'local' : 'dashscope');
  if (provider === 'local')
    return {
      ...legacyModelProfile(),
      model: config.get('LEGACY_EMBEDDING_MODEL') || LEGACY_MODEL,
      revision: config.get('LEGACY_EMBEDDING_REVISION') || LEGACY_REVISION,
      tokenizer:
        config.get('STORAGE_DRIVER') === 'memory'
          ? 'test:unicode-v1'
          : config.get('EMBEDDING_TOKENIZER') || LEGACY_MODEL,
      chunkingVersion: 'tokens-v1',
    };
  return {
    provider: 'dashscope',
    model: config.get('EMBEDDING_MODEL') || 'qwen3.7-text-embedding-flash',
    revision: config.get('EMBEDDING_REVISION') || 'api-v1',
    dimensions: Number(config.get('EMBEDDING_DIMENSIONS') || 1024),
    tokenizer: config.get('EMBEDDING_TOKENIZER') || 'estimate:utf8-v1',
    tokenizerDigest: tokenizerDigest(config.get('EMBEDDING_TOKENIZER') || ''),
    chunkingVersion: 'tokens-v1',
  };
}
export function profileFingerprint(profile: ModelProfile): string {
  // Old collection suffix must remain byte-for-byte compatible with pre-migration indexes.
  const values =
    profile.provider === 'local'
      ? [profile.model, profile.revision, 384, 'mean', 'normalize', 'fp32']
      : [profile.provider, profile.model, profile.revision, profile.dimensions, 'normalize'];
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
