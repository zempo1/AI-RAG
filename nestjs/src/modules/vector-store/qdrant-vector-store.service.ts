import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  currentModelProfile,
  legacyModelProfile,
  ModelProfile,
  profileFingerprint,
} from '../embeddings/model-profile';
import { Match, SearchScope, Segment, VectorStore } from './vector-store.interface';
import { pointId } from './point-id';

export function embeddingFingerprint(config: ConfigService) {
  return profileFingerprint(currentModelProfile(config));
}

@Injectable()
export class QdrantVectorStore extends VectorStore {
  private readonly client: QdrantClient;
  private readonly prefix: string;
  private readonly defaultProfile: ModelProfile;
  private readonly initialized = new Map<string, Promise<void>>();

  constructor(config: ConfigService) {
    super();
    this.client = new QdrantClient({
      url: config.getOrThrow('QDRANT_URL'),
      apiKey: config.get('QDRANT_API_KEY') || undefined,
      timeout: 30000,
      checkCompatibility: false,
    });
    this.prefix = config.get('QDRANT_COLLECTION') || 'rag';
    this.defaultProfile = currentModelProfile(config);
  }

  private collectionFor(profile: ModelProfile) {
    return this.prefix + '_' + profileFingerprint(profile).slice(0, 16);
  }
  private async ready(profile: ModelProfile = this.defaultProfile) {
    const collection = this.collectionFor(profile);
    if (!this.initialized.has(collection))
      this.initialized.set(
        collection,
        this.initialize(collection, profile.dimensions).catch((error) => {
          this.initialized.delete(collection);
          throw error;
        }),
      );
    await this.initialized.get(collection);
    return collection;
  }
  private async initialize(collection: string, dimensions: number) {
    const exists = await this.client.collectionExists(collection);
    if (!exists.exists) {
      try {
        await this.client.createCollection(collection, {
          vectors: { size: dimensions, distance: 'Cosine' },
        });
      } catch (error: any) {
        if (error.status !== 409 && !(await this.client.collectionExists(collection)).exists)
          throw error;
      }
    }
    const info = await this.client.getCollection(collection);
    const vector = info.config.params.vectors as { size?: number; distance?: string };
    if (vector.size !== dimensions || vector.distance !== 'Cosine')
      throw new Error('Qdrant collection 与当前 Embedding 配置不兼容');
    for (const field of ['userId', 'knowledgeBaseId', 'documentId', 'indexRevisionId']) {
      await this.client.createPayloadIndex(collection, {
        field_name: field,
        field_schema: 'integer',
        wait: true,
      });
    }
  }

  async addAll(
    vectors: number[][],
    segments: Segment[],
    profile: ModelProfile = this.defaultProfile,
  ) {
    if (
      vectors.length !== segments.length ||
      vectors.some(
        (v) =>
          v.length !== profile.dimensions || !v.every(Number.isFinite) || !v.some((x) => x !== 0),
      )
    )
      throw new Error('Invalid embedding vectors');
    if (!segments.length) return;
    if (segments.some((s) => !s.knowledgeBaseId || !s.indexRevisionId))
      throw new Error('Missing vector scope');
    const collection = await this.ready(profile);
    await this.client.upsert(collection, {
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
    const profile = scope.modelProfile || this.defaultProfile;
    if (vector.length !== profile.dimensions)
      throw new Error('Query vector dimension does not match model profile');
    const collection = await this.ready(profile);
    const result = await this.client.query(collection, {
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
    const known = await this.client.getCollections();
    for (const c of known.collections.filter((c) => c.name.startsWith(this.prefix + '_')))
      await this.client.delete(c.name, {
        wait: true,
        filter: {
          must: [
            { key: 'userId', match: { value: userId } },
            { key: 'documentId', match: { value: documentId } },
          ],
        },
      });
  }
  async removeRevision(indexRevisionId: number, userId: number, profile?: ModelProfile) {
    const names = profile
      ? [this.collectionFor(profile)]
      : (await this.client.getCollections()).collections
          .filter((c) => c.name.startsWith(this.prefix + '_'))
          .map((c) => c.name);
    for (const name of names) {
      if (!(await this.client.collectionExists(name)).exists) continue;
      await this.client.delete(name, {
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
}
