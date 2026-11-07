import { RetrievalScope, OriginalEvidence } from '../rag/retrieval.types';
import { RetrievalOptions } from '../rag/quality.types';
import { AgentBudgetState } from './agent-budget';
import { ToolMessage, ToolCall } from '../llm/llm.types';
export interface PublicStep {
  runId: number;
  sequence: number;
  kind: 'plan' | 'tool_start' | 'tool_end' | 'assessment' | 'handoff' | 'stop';
  summary: string;
  tool?: string;
  evidenceCount?: number;
  elapsedMs?: number;
  sources?: { filename: string; page: number | null }[];
}
export interface AgentOptions extends RetrievalOptions {
  onAgentStep?: (step: PublicStep) => Promise<void> | void;
  onCheckpoint?: (snapshot: AgentSnapshot) => Promise<void>;
  guard?: () => Promise<unknown> | unknown;
  background?: boolean;
  evaluation?: 'single-round' | 'no-feedback';
}
export interface AgentSnapshot {
  engine: 'agentic-v1';
  userId: number;
  knowledgeBaseId: number;
  chatId?: number;
  question: string;
  runId: number;
  scope: RetrievalScope;
  plan: any;
  steps: PublicStep[];
  budget: AgentBudgetState;
  phase: string;
  evidence: OriginalEvidence[];
  messages: ToolMessage[];
  pending: ToolCall[];
  journal: Record<string, string>;
  toolEvidence?: Record<string, OriginalEvidence[]>;
  summaries?: Record<string, { summary: string; refs: Record<string, string> }[]>;
  summaryCoverage?: Record<
    string,
    {
      complete: boolean;
      totalSections: number;
      completedSections: number;
      documentId?: number;
      fullDocument?: boolean;
    }
  >;
  status?: 'running' | 'ready' | 'completed' | 'partial' | 'insufficient' | 'clarification';
  noProgress: number;
  roundEvidenceCount?: number;
  repairUsed: boolean;
  activeStarted?: number;
  history: any[];
  mode?: string;
  stopReason?: string;
  directAnswer?: string;
}
