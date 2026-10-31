import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'node:crypto';
import { Match, SearchScope, Segment, VectorStore } from './vector-store.interface';
import { pointId } from './point-id';

export function embeddingFingerprint(config: ConfigService) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.get('EMBEDDING_MODEL'),
        config.get('EMBEDDING_REVISION'),
        384,
        'mean',
        'normalize',
        'fp32',
      ]),
    )
    .digest('hex');
}

@Injectable()
export class QdrantVectorStore extends VectorStore {
  private readonly client: QdrantClient;
  private readonly collection: string;
  private initialized?: Promise<void>;

  constructor(config: ConfigService) {
    super();
    this.client = new QdrantClient({
      url: config.getOrThrow('QDRANT_URL'),
      apiKey: config.get('QDRANT_API_KEY') || undefined,
      timeout: 30000,
      checkCompatibility: false,
    });
    this.collection =
      (config.get('QDRANT_COLLECTION') || 'rag') + '_' + embeddingFingerprint(config).slice(0, 16);
  }

  private async ready() {
    if (!this.initialized)
      this.initialized = this.initialize().catch((error) => {
        this.initialized = undefined;
        throw error;
      });
    return this.initialized;
  }

  private async initialize() {
    const exists = await this.client.collectionExists(this.collection);
    if (!exists.exists) {
      try {
        await this.client.createCollection(this.collection, {
          vectors: { size: 384, distance: 'Cosine' },
        });
      } catch (error: any) {
        if (error.status !== 409 && !(await this.client.collectionExists(this.collection)).exists)
          throw error;
      }
    }
    const info = await this.client.getCollection(this.collection);
    const vector = info.config.params.vectors as { size?: number; distance?: string };
    if (vector.size !== 384 || vector.distance !== 'Cosine')
      throw new Error('Qdrant collection 与当前 Embedding 配置不兼容');
    for (const field of ['userId', 'knowledgeBaseId', 'documentId', 'indexRevisionId']) {
      await this.client.createPayloadIndex(this.collection, {
        field_name: field,
        field_schema: 'integer',
        wait: true,
      });
    }
  }

  async addAll(vectors: number[][], segments: Segment[]) {
    if (
      vectors.length !== segments.length ||
      vectors.some((v) => v.length !== 384 || !v.every(Number.isFinite) || !v.some((x) => x !== 0))
    )
      throw new Error('Invalid embedding vectors');
    if (!segments.length) return;
    if (segments.some((s) => !s.knowledgeBaseId || !s.indexRevisionId))
      throw new Error('Missing vector scope');
    await this.ready();
    await this.client.upsert(this.collection, {
      wait: true,
      points: segments.map((segment, i) => ({
        id: pointId(segment),
        vector: vectors[i],
        payload: { ...segment },
      })),
    });
  }

  async search(
    vector: number[],
    topK: number,
    minScore: number,
    scope?: SearchScope,
  ): Promise<Match[]> {
    if (!scope) throw new Error('Qdrant search requires an authorized knowledge base scope');
    if (!scope.indexRevisionIds.length) return [];
    await this.ready();
    const result = await this.client.query(this.collection, {
      query: vector,
      limit: topK,
      score_threshold: minScore * 2 - 1,
      with_payload: true,
      filter: {
        must: [
          { key: 'userId', match: { value: scope.userId } },
          { key: 'knowledgeBaseId', match: { value: scope.knowledgeBaseId } },
          { key: 'indexRevisionId', match: { any: scope.indexRevisionIds } },
        ],
      },
    });
    return result.points.map((p) => ({
      segment: p.payload as unknown as Segment,
      score: (p.score + 1) / 2,
    }));
  }

  async removeDocument(documentId: number, userId: number) {
    await this.ready();
    await this.client.delete(this.collection, {
      wait: true,
      filter: {
        must: [
          { key: 'userId', match: { value: userId } },
          { key: 'documentId', match: { value: documentId } },
        ],
      },
    });
  }

  async removeRevision(indexRevisionId: number, userId: number) {
    await this.ready();
    await this.client.delete(this.collection, {
      wait: true,
      filter: {
        must: [
          { key: 'userId', match: { value: userId } },
          { key: 'indexRevisionId', match: { value: indexRevisionId } },
        ],
      },
    });
  }
}
