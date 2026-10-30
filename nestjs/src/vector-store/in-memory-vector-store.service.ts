import { Injectable } from '@nestjs/common';
import { VectorStore, Segment, Match } from './vector-store.interface';

@Injectable()
export class InMemoryVectorStore extends VectorStore {
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
    this.entries.push(
      ...vectors.map((vector, i) => ({ vector: [...vector], segment: { ...segments[i] } })),
    );
  }

  search(vector: number[], topK: number, minScore: number): Match[] {
    if (!this.entries.length) return [];
    this.validate(vector, this.dimension!);
    const norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    const queryNorm = norm(vector);
    return this.entries
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
