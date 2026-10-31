import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmbeddingsService implements OnModuleDestroy {
  private extractor?: Promise<any>;

  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  private load(): Promise<any> {
    if (!this.extractor)
      this.extractor = (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');
        env.cacheDir = this.config.getOrThrow('MODEL_CACHE_DIR');
        return pipeline('feature-extraction', this.config.getOrThrow('EMBEDDING_MODEL'), {
          revision: this.config.getOrThrow('EMBEDDING_REVISION'),
          dtype: 'fp32',
          device: 'cpu',
        });
      })().catch((error) => {
        this.extractor = undefined;
        throw error;
      });
    return this.extractor;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
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

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embedDocuments([text]))[0];
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.catch(() => undefined);
    if (this.extractor) {
      const extractor = await this.extractor;
      await extractor.dispose();
    }
  }
}
