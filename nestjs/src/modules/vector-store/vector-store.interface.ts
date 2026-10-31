import { SourceLocation } from '../documents/parsers/parsed-document';
export interface Segment {
  text: string;
  userId: number;
  documentId: number;
  filename: string;
  chunkIndex: number;
  knowledgeBaseId?: number;
  versionId?: number;
  indexRevisionId?: number;
  chunkId?: number;
  location?: SourceLocation;
}

export interface SearchScope {
  userId: number;
  knowledgeBaseId: number;
  indexRevisionIds: number[];
}

export interface Match {
  segment: Segment;
  score: number;
}

export abstract class VectorStore {
  abstract removeDocument(documentId: number, userId: number): void | Promise<void>;
  abstract removeRevision(indexRevisionId: number, userId: number): void | Promise<void>;

  abstract addAll(vectors: number[][], segments: Segment[]): void | Promise<void>;

  abstract search(
    vector: number[],
    topK: number,
    minScore: number,
    scope?: SearchScope,
  ): Match[] | Promise<Match[]>;
}
