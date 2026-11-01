import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  currentModelProfile,
  legacyModelProfile,
  ModelProfile,
  assertTokenizerProfile,
} from './model-profile';
import { TokenizerService } from './tokenizer.service';

@Injectable()
export class EmbeddingsService implements OnModuleDestroy {
  private extractor?: Promise<any>;

  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  currentProfile() {
    return currentModelProfile(this.config);
  }
  legacyProfile() {
    return legacyModelProfile(this.config);
  }

  private load(): Promise<any> {
    if (!this.extractor)
      this.extractor = (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');
        env.cacheDir = this.config.getOrThrow('MODEL_CACHE_DIR');
        return pipeline('feature-extraction', legacyModelProfile(this.config).model, {
          revision: legacyModelProfile(this.config).revision,
          dtype: 'fp32',
          device: 'cpu',
        });
      })().catch((error) => {
        this.extractor = undefined;
        throw error;
      });
    return this.extractor;
  }

  async embedDocuments(
    texts: string[],
    profile: ModelProfile = this.currentProfile(),
  ): Promise<number[][]> {
    assertTokenizerProfile(profile);
    if (profile.provider === 'dashscope') return this.remote(texts, profile);
    if (!texts.length) return [];
    const run = async () => {
      const extractor = await this.load();
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const tensor = await extractor(texts.slice(i, i + 16), {
          pooling: 'mean',
          normalize: true,
        });
        const batch = tensor.tolist() as number[][];
        if (
          batch.length !== Math.min(16, texts.length - i) ||
          batch.some((v) => v.length !== 384 || !v.every(Number.isFinite))
        )
          throw new Error('Invalid MiniLM embedding response');
        vectors.push(...batch);
      }
      return vectors;
    };
    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async embedQuery(text: string, profile: ModelProfile = this.currentProfile()): Promise<number[]> {
    return (await this.embedDocuments([text], profile))[0];
  }

  private async remote(texts: string[], profile: ModelProfile): Promise<number[][]> {
    if (!texts.length) return [];
    const key = this.config.get<string>('EMBEDDING_API_KEY') || this.config.get<string>('CHAT_API_KEY');
    if (!key) throw new Error('请配置 EMBEDDING_API_KEY 或 CHAT_API_KEY');
    const tokenizer = new TokenizerService(this.config);
    for (const text of texts)
      if ((await tokenizer.count(text, profile.tokenizer)) > 8192)
        throw new Error('Embedding 输入超过模型 token 上限，拒绝静默截断');
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += 10) {
      const input = texts.slice(i, i + 10);
      const response = await fetch(
        (
          this.config.get<string>('EMBEDDING_BASE_URL') ||
          'https://dashscope.aliyuncs.com/compatible-mode/v1'
        ).replace(/\/$/, '') + '/embeddings',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: profile.model,
            input,
            dimensions: profile.dimensions,
            encoding_format: 'float',
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw new Error('Embedding API HTTP ' + response.status);
      const body: any = await response.json();
      const rows = [...(body.data || [])].sort((a, b) => a.index - b.index);
      if (
        rows.length !== input.length ||
        rows.some(
          (r, i) =>
            r.index !== i ||
            !Array.isArray(r.embedding) ||
            r.embedding.length !== profile.dimensions ||
            !r.embedding.every(Number.isFinite) ||
            !r.embedding.some((x: number) => x !== 0),
        )
      )
        throw new Error('Invalid API embedding response');
      all.push(...rows.map((r) => r.embedding));
    }
    return all;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.catch(() => undefined);
    if (this.extractor) {
      const extractor = await this.extractor;
      await extractor.dispose();
    }
  }
}
