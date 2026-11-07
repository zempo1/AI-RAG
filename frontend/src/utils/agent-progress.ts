export type AgentStepKind = 'plan' | 'tool_start' | 'tool_end' | 'assessment' | 'handoff' | 'stop';
export interface AgentStep {
  runId: number;
  sequence: number;
  kind: AgentStepKind;
  summary: string;
  tool?: string;
  evidenceCount?: number;
  elapsedMs?: number;
  sources?: { filename: string; page: number | null }[];
}
export interface AgentProgress {
  plan?: { intent: string; complexity: string; subQuestions: string[] };
  steps: AgentStep[];
  budget?: Record<string, unknown>;
  stopReason?: string | null;
  status?: string;
}
export function mergeAgentSteps(previous: AgentStep[], incoming: AgentStep[]): AgentStep[] {
  const steps = new Map(previous.map(step => [`${step.runId}:${step.sequence}`, step]));
  for (const step of incoming) {
    const key = `${step.runId}:${step.sequence}`;
    if (!steps.has(key)) steps.set(key, step);
  }
  return [...steps.values()].sort((a, b) => a.runId - b.runId || a.sequence - b.sequence);
}
export function getAgentProgress(diagnostics?: Record<string, any> | null): AgentProgress | null {
  const agent = diagnostics?.agent;
  return agent && Array.isArray(agent.steps) ? agent : null;
}
export function requestTaskCancellation(id: number, post: (url: string) => Promise<unknown>) {
  return post(`/api/tasks/${id}/cancel`);
}
