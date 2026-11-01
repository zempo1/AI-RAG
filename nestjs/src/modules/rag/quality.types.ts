import { Citation } from './citations';
export type QueryMode = 'auto' | 'general' | 'search' | 'overview' | 'compare';
export interface HistoryTurn {
  role: string;
  content: string;
  citations?: Citation[];
  retrievalContext?: unknown;
}
export interface RetrievalOptions {
  onProgress?: (stage: string) => void;
  documentIds?: number[];
  mode?: QueryMode;
  history?: HistoryTurn[];
  chatId?: number;
  apiKey?: string;
}
export interface EvidenceSnapshot {
  userId: number;
  knowledgeBaseId: number;
  chatId?: number;
  question: string;
  mode: string;
  sources: Citation[];
  revisions: number[];
  history: HistoryTurn[];
  diagnostics: Record<string, any>;
}
export interface RetrievalResult {
  prompt: string;
  sources: Citation[];
  knowledgeBaseId: number;
  directAnswer?: string;
  diagnostics: Record<string, any>;
  requiresAsync?: boolean;
  snapshot?: EvidenceSnapshot;
}
