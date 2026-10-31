import { Injectable } from '@nestjs/common';
import { VectorStore, Segment, Match, SearchScope } from './vector-store.interface';
import { pointId } from './point-id';

@Injectable()
export class InMemoryVectorStore extends VectorStore {
  removeRevision(indexRevisionId: number, userId: number): void {
    this.entries = this.entries.filter(
      (e) => e.segment.userId !== userId || e.segment.indexRevisionId !== indexRevisionId,
    );
    if (!this.entries.length) this.dimension = undefined;
  }
  removeDocument(documentId: number, userId: number): void {
    this.entries = this.entries.filter(
      (entry) => entry.segment.documentId !== documentId || entry.segment.userId !== userId,
    );
    if (!this.entries.length) this.dimension = undefined;
  }

  private entries: { vector: number[]; segment: Segment }[] = [];

  private dimension?: number;

  private validate(vector: number[], dimension: number): void {
    if (
      !vector.length ||
      vector.length !== dimension ||
      !vector.every(Number.isFinite) ||
      !vector.some((v) => v !== 0)
    )
      throw new Error('Invalid embedding vector or dimension mismatch');
  }

  addAll(vectors: number[][], segments: Segment[]): void {
    if (vectors.length !== segments.length) throw new Error('Embedding count mismatch');
    if (!vectors.length) return;
    const dimension = this.dimension ?? vectors[0].length;
    vectors.forEach((v) => this.validate(v, dimension));
    this.dimension = dimension;
    for (let i = 0; i < vectors.length; i++) {
      const segment = segments[i];
      const id = pointId(segment);
      this.entries = this.entries.filter((e) => pointId(e.segment) !== id);
      this.entries.push({ vector: [...vectors[i]], segment: structuredClone(segment) });
    }
  }

  search(vector: number[], topK: number, minScore: number, scope?: SearchScope): Match[] {
    if (!this.entries.length) return [];
    this.validate(vector, this.dimension!);
    const norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    const queryNorm = norm(vector);
    return this.entries
      .filter(
        (e) =>
          !scope ||
          (e.segment.userId === scope.userId &&
            e.segment.knowledgeBaseId === scope.knowledgeBaseId &&
            scope.indexRevisionIds.includes(e.segment.indexRevisionId!)),
      )
      .map((entry) => ({
        segment: { ...entry.segment },
        score:
          (Math.max(
            -1,
            Math.min(
              1,
              entry.vector.reduce((sum, x, i) => sum + x * vector[i], 0) /
                (norm(entry.vector) * queryNorm),
            ),
          ) +
            1) /
          2,
      }))
      .filter((m) => m.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
