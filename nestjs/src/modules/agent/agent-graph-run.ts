import { Store, now } from '../../persistence/store';
import { AgentBudget, AgentBudgetState } from './agent-budget';
import { AgentGraphOwner, withAgentGraphOwner } from './agent-graph-owner';
import type { AgentSnapshot, PublicStep } from './agent.types';

export interface AgentLedger {
  budget: AgentBudgetState;
  repairUsed: boolean;
}

/** The graph owns routing and evidence. The ledger charges work even if its node fails. */
export class AgentGraphRun {
  readonly budget: AgentBudgetState;
  repairUsed: boolean;
  steps: PublicStep[];
  private clock = Date.now();

  constructor(
    private readonly store: Store,
    private readonly owner: AgentGraphOwner | undefined,
    ledger: AgentLedger | undefined,
    steps: PublicStep[],
  ) {
    this.budget = ledger?.budget ?? AgentBudget.initial();
    this.repairUsed = ledger?.repairUsed ?? false;
    this.steps = steps;
  }

  resetClock() {
    this.clock = Date.now();
  }

  publicBudget() {
    const { reservations, nextReservation, ...totals } = this.budget;
    return totals;
  }

  async charge(state: AgentSnapshot) {
    const time = Date.now();
    this.budget.activeMs += Math.max(0, time - this.clock);
    this.clock = time;
    this.repairUsed ||= state.repairUsed;
    if (!this.owner) return;
    await withAgentGraphOwner(this.store, this.owner, async (tx, task) => {
      await tx.save('tasks', {
        id: task.id, updatedAt: now(), stage: state.phase, completed: this.budget.decisions,
        payload: {
          ...task.payload, leaseUntil: Date.now() + 300000,
          agentBudgetLedger: { budget: this.budget, repairUsed: this.repairUsed } satisfies AgentLedger,
          agentProgress: {
            ...task.payload.agentProgress, budget: this.publicBudget(),
            status: state.status ?? state.phase, stopReason: state.stopReason ?? null,
          },
        },
      });
    });
  }

  async publish(key: string, state: AgentSnapshot, step: PublicStep) {
    if (!this.owner) {
      this.steps = [...this.steps, { ...step, sequence: (this.steps.at(-1)?.sequence ?? 0) + 1 }];
      const event = this.steps.at(-1)!;
      await this.finish(state, { engine: state.engine, agent: {
        plan: state.plan, steps: this.steps, budget: this.publicBudget(), stopReason: state.stopReason,
        status: step.kind === 'stop' ? 'ready' : 'running',
      } });
      return event;
    }
    const result = await withAgentGraphOwner(this.store, this.owner, async (tx, task) => {
      const events: Record<string, number> = task.payload.agentEventSequences ?? {};
      if (Object.hasOwn(events, key)) return undefined;
      const sequence = (task.payload.agentEventSequence ?? 0) + 1;
      const event = { ...step, sequence };
      const steps = [...(task.payload.agentProgress?.steps ?? []), event].slice(-100);
      const progress = {
        plan: state.plan, steps, budget: this.publicBudget(),
        stopReason: state.stopReason ?? null, status: state.status ?? state.phase,
      };
      await tx.save('tasks', { id: task.id, updatedAt: now(), payload: {
        ...task.payload, agentProgress: progress, agentEventSequence: sequence,
        agentEventSequences: { ...events, [key]: sequence },
      } });
      await tx.save('retrievalRuns', { id: state.runId, payload: {
        engine: state.engine, agent: { ...progress, status: step.kind === 'stop' ? 'ready' : 'running' },
      } });
      return { event, steps };
    });
    if (result && result.event.sequence > (this.steps.at(-1)?.sequence ?? 0)) this.steps = result.steps;
    return result?.event;
  }

  async finish(state: AgentSnapshot, payload: object) {
    if (!this.owner) {
      if (this.store?.save && state.runId) await this.store.save('retrievalRuns', { id: state.runId, payload });
      return;
    }
    await withAgentGraphOwner(this.store, this.owner, (tx) =>
      tx.save('retrievalRuns', { id: state.runId, payload }));
  }
}
