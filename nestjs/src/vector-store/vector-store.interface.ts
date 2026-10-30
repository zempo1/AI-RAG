export interface Segment {
  text: string;
  userId: number;
  documentId: number;
  filename: string;
  chunkIndex: number;
}

export interface Match {
  segment: Segment;
  score: number;
}

export abstract class VectorStore {
  abstract addAll(vectors: number[][], segments: Segment[]): void;

  abstract search(vector: number[], topK: number, minScore: number): Match[];
}
