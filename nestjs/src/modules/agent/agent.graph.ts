import { isDeepStrictEqual } from 'node:util';
import { Annotation, Command, END, interrupt, START, StateGraph, task } from '@langchain/langgraph';
import type { StateSnapshot } from '@langchain/langgraph';
import { AgentLimitError } from './agent-budget';
import type { AgentOptions, AgentSnapshot } from './agent.types';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { OriginalEvidence } from '../rag/retrieval.types';
import type { ToolCall } from '../llm/llm.types';

export type AgentNodeName = 'plan' | 'decide' | 'tool' | 'assess';
type Destination = AgentNodeName | 'finalize';
export function isAgentDestination(phase: string): phase is Destination {
  return ['plan', 'decide', 'tool', 'assess', 'finalize'].includes(phase);
}

interface Prepared {
  prompt: string;
  sources: OriginalEvidence[];
  coverageComplete?: boolean;
  directAnswer?: string;
}

export const HANDOFF_KIND = 'agent_handoff';
export const isAgentHandoff = (snapshot?: StateSnapshot) => snapshot?.tasks.some(
  entry => entry.interrupts?.some(item => (item.value as { kind?: string })?.kind === HANDOFF_KIND),
);

const Channels = Annotation.Root({
  input: Annotation<Pick<AgentSnapshot, 'engine' | 'userId' | 'knowledgeBaseId' | 'chatId' | 'question' |
    'runId' | 'scope' | 'history' | 'mode'>>(),
  planning: Annotation<AgentSnapshot['plan']>(),
  evidence: Annotation<AgentSnapshot['evidence']>(),
  messages: Annotation<AgentSnapshot['messages']>(),
  pending: Annotation<AgentSnapshot['pending']>(),
  journal: Annotation<AgentSnapshot['journal']>(),
  toolEvidence: Annotation<AgentSnapshot['toolEvidence']>(),
  summaries: Annotation<AgentSnapshot['summaries']>(),
  summaryCoverage: Annotation<AgentSnapshot['summaryCoverage']>(),
  status: Annotation<AgentSnapshot['status']>(),
  noProgress: Annotation<AgentSnapshot['noProgress']>(),
  roundEvidenceCount: Annotation<AgentSnapshot['roundEvidenceCount']>(),
  evidenceGaps: Annotation<AgentSnapshot['evidenceGaps']>(),
  stopReason: Annotation<AgentSnapshot['stopReason']>(),
  directAnswer: Annotation<AgentSnapshot['directAnswer']>(),
  handoffTo: Annotation<AgentNodeName | null>(),
  entryPhase: Annotation<Destination>(),
  turn: Annotation<number>(),
  prepared: Annotation<Prepared>(),
});

export type AgentGraphState = typeof Channels.State;
const businessFields = [
  'evidence', 'messages', 'pending', 'journal', 'toolEvidence', 'summaries', 'summaryCoverage',
  'status', 'noProgress', 'roundEvidenceCount', 'evidenceGaps', 'stopReason', 'directAnswer',
] as const;

export function graphInput(snapshot: AgentSnapshot): Partial<AgentGraphState> {
  const { engine, userId, knowledgeBaseId, chatId, question, runId, scope, history, mode } = snapshot;
  return {
    input: { engine, userId, knowledgeBaseId, chatId, question, runId, scope, history, mode },
    turn: 0, handoffTo: null, planning: snapshot.plan,
    ...(snapshot.phase !== 'plan' && isAgentDestination(snapshot.phase) ? { entryPhase: snapshot.phase } : {}),
    ...Object.fromEntries(businessFields.map(field => [field, snapshot[field]])),
  };
}

export function graphDraft(state: AgentGraphState, phase: Destination, options: AgentOptions): AgentSnapshot {
  const values = Object.fromEntries(businessFields.map(field => [field, state[field]]));
  return {
    ...structuredClone({ ...state.input, ...values, plan: state.planning }) as AgentSnapshot,
    phase, budget: options.graphRun!.budget, repairUsed: options.graphRun!.repairUsed,
    steps: options.graphRun!.steps,
  };
}

/** Child errors abort the whole LangGraph superstep. Let the parent handle them after all writes settle. */
export async function runDurableTools<T>(
  jobs: Map<string, { call: ToolCall; index: number }>,
  execute: (call: ToolCall, index: number) => Promise<T>,
) {
  const failures = new Map<number, unknown>();
  const run = task('agent_tool', async (call: ToolCall, index: number) => {
    try {
      return { ok: true as const, value: await execute(call, index) };
    } catch (error) {
      failures.set(index, error);
      return { ok: false as const };
    }
  });
  const outcomes = new Map<string, PromiseSettledResult<T>>();
  let pending = [...jobs];
  while (pending.length) {
    // Fixed order keeps native task IDs stable across replays of the same parent node.
    const results = await Promise.all(pending.map(([, job]) => run(job.call, job.index)));
    pending = pending.filter(([key, job], index) => {
      const result = results[index];
      if (result.ok) outcomes.set(key, { status: 'fulfilled', value: result.value });
      else if (failures.has(job.index)) outcomes.set(key, { status: 'rejected', reason: failures.get(job.index) });
      else return true; // A failure marker from an earlier run. Schedule another attempt.
      return false;
    });
  }
  return outcomes;
}

interface AgentGraphNodes {
  steps: Record<AgentNodeName, (state: AgentSnapshot, options: AgentOptions) => Promise<{ next: string }>>;
  boundary: (state: AgentSnapshot, options: AgentOptions) => Promise<boolean>;
  exhausted: (state: AgentSnapshot, options: AgentOptions) => Promise<void>;
  finalize: (state: AgentSnapshot, options: AgentOptions) => Promise<Prepared>;
}

export function compileAgentGraph(checkpointer: BaseCheckpointSaver, options: AgentOptions, nodes: AgentGraphNodes) {
  const patch = (state: AgentGraphState, draft: AgentSnapshot) => ({
    ...(!isDeepStrictEqual(state.planning, draft.plan) ? { planning: draft.plan } : {}),
    ...Object.fromEntries(businessFields.filter(field => !isDeepStrictEqual(state[field], draft[field]))
      .map(field => [field, draft[field]])),
  });
  const run = (phase: AgentNodeName) => async (state: AgentGraphState) => {
    const local = { ...options, graphEventPrefix: `${state.turn}:${phase}` };
    const draft = graphDraft(state, phase, local);
    let next: string;
    try {
      next = (await nodes.boundary(draft, local)) ? 'end' : (await nodes.steps[phase](draft, local)).next;
    } catch (error) {
      if (!(error instanceof AgentLimitError)) throw error;
      await nodes.exhausted(draft, local);
      next = 'finalize';
    }
    const update = { ...patch(state, draft), turn: state.turn + 1 };
    return next === 'end'
      ? new Command({ goto: 'handoff', update: { ...update, handoffTo: phase } })
      : new Command({ goto: next, update });
  };

  return new StateGraph(Channels)
    .addNode('plan', run('plan'), { ends: ['decide', 'tool', 'finalize', 'handoff'] })
    .addNode('decide', run('decide'), { ends: ['tool', 'assess', 'finalize', 'handoff'] })
    .addNode('tool', run('tool'), { ends: ['tool', 'decide', 'assess', 'finalize', 'handoff'] })
    .addNode('assess', run('assess'), { ends: ['decide', 'finalize', 'handoff'] })
    .addNode('handoff', (state) => {
      interrupt({ kind: HANDOFF_KIND });
      if (!state.handoffTo) throw new Error('Agent 暂停缺少恢复节点');
      return new Command({ goto: state.handoffTo, update: { handoffTo: null } });
    }, { ends: ['plan', 'decide', 'tool', 'assess'] })
    .addNode('finalize', async (state) => {
      const local = { ...options, graphEventPrefix: `${state.turn}:finalize` };
      const draft = graphDraft(state, 'finalize', local);
      const prepared = await nodes.finalize(draft, local);
      return { ...patch(state, draft), prepared };
    })
    .addConditionalEdges(START, (state) => state.entryPhase ?? 'plan', ['plan', 'decide', 'tool', 'assess', 'finalize'])
    .addEdge('finalize', END)
    .compile({ checkpointer });
}
