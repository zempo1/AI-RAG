import { Row } from '../../persistence/store';
import { Citation } from './citations';
import { Scored } from './retrieval-algorithms';

/** Serializable authorization snapshot. Capture once; tools may only narrow it. */
export interface RetrievalScope {
  userId: number;
  knowledgeBaseId: number;
  documents: { documentId: number; filename: string; indexRevisionId: number }[];
}
export interface RetrievalSession {
  scope: RetrievalScope;
  documents: Row[];
  chunks: Row[];
  revisions: Map<number, Row>;
  byChunk: Map<number, Row>;
  byDoc: Map<number, Row>;
}
export interface OriginalEvidence extends Citation { evidenceId: string }
export interface SearchOptions {
  strategy?: 'keyword' | 'vector' | 'hybrid' | 'hybrid-rerank';
  limit?: number;
  signal?: AbortSignal;
  onProgress?: (stage: string) => void;
  /** Original exact query for the lexical channel when baseline query rewriting is used. */
  lexicalQuery?: string;
}
export interface SearchResult {
  candidates: Scored[];
  evidence: OriginalEvidence[];
  channels: { lexical: Scored[]; vector: Scored[]; fused: Scored[]; reranked: Scored[] };
  degraded: string[];
}
export interface ReadRange {
  documentId: number;
  pageStart?: number;
  pageEnd?: number;
  heading?: string;
  cursor?: number;
  limit?: number;
}
