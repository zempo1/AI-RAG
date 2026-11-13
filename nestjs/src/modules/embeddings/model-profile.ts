import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { currentModels, environmentBindings, modelBinding, ModelProvider, normalizedModelUrl } from '../model-settings/model-runtime';
import { ApiError } from '../../common/api-error';

export interface ModelProfile {
  provider: ModelProvider;
  baseUrl?: string;
  sendDimensions?: boolean;
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
  const binding = modelBinding(config, 'embedding');
  if (binding.custom) return {
    provider: binding.provider, baseUrl: binding.baseUrl, sendDimensions: binding.sendDimensions,
    model: binding.model, dimensions: binding.dimensions!,
    revision: config.get('EMBEDDING_REVISION') || 'api-v1',
    tokenizer: config.get('EMBEDDING_TOKENIZER') || 'estimate:utf8-v1',
    tokenizerDigest: tokenizerDigest(config.get('EMBEDDING_TOKENIZER') || ''), chunkingVersion: 'tokens-v1',
  };
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
  // Profiles predating account settings keep their exact collection suffix.
  if (profile.baseUrl) values.push(profile.baseUrl);
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

export function assertEmbeddingCompatible(profile: ModelProfile, config: ConfigService) {
  const active = currentModels()?.bindings.embedding;
  if (!active || (!active.custom && !profile.baseUrl)) return;
  const current = currentModelProfile(config);
  const identity = (p: ModelProfile) => JSON.stringify([p.provider === 'local' ? 'local' : 'remote',
    p.provider === 'local' ? '' : normalizedModelUrl(p.baseUrl || environmentBindings(config).embedding.baseUrl),
    p.model, p.revision, p.dimensions, p.tokenizer, p.chunkingVersion]);
  if (identity(profile) !== identity(current)) throw new ApiError(409, '向量模型已变更，请重建索引');
}
