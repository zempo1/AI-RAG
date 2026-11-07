import { ModelCallObserver, ModelCallOutcome, ModelCallRequest } from '../llm/llm.types';

export class AgentLimitError extends Error {
  readonly retryable = false;
  constructor(message = 'Agent 预算已耗尽') {
    super(message);
    this.name = 'AgentLimitError';
  }
}
export interface AgentBudgetState {
  calls: number;
  tokens: number;
  reservations: Record<string, number>;
  nextReservation: number;
  decisions: number;
  tools: number;
  assessments: number;
  activeMs: number;
  providerTokens: number;
  estimatedTokens: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
}
export interface AgentBudgetLimits {
  calls: number;
  tokens: number;
  activeMs: number;
  finalReserve: number;
  contextTokens?: number;
}
/** Reservations are charged immediately and remain charged after a crash. */
export class AgentBudget implements ModelCallObserver {
  private static readonly locks = new WeakMap<AgentBudgetState, Promise<void>>();
  constructor(
    public readonly state: AgentBudgetState,
    private readonly checkpoint: () => Promise<void>,
    private readonly final = false,
    private readonly guard?: () => Promise<unknown> | unknown,
    private readonly signal?: AbortSignal,
    private readonly limits: AgentBudgetLimits = {
      calls: 32,
      tokens: 100000,
      activeMs: 600000,
      finalReserve: 32768,
    },
  ) {}
  static initial(): AgentBudgetState {
    return {
      calls: 0,
      tokens: 0,
      reservations: {},
      nextReservation: 0,
      decisions: 0,
      tools: 0,
      assessments: 0,
      activeMs: 0,
      providerTokens: 0,
      estimatedTokens: 0,
    };
  }
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const previous = AgentBudget.locks.get(this.state) || Promise.resolve();
    let release!: () => void;
    AgentBudget.locks.set(
      this.state,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async before(request: ModelCallRequest): Promise<string> {
    return this.serial(async () => {
      this.signal?.throwIfAborted();
      await this.guard?.();
      const input = Buffer.byteLength(
        typeof request.input === 'string' ? request.input : JSON.stringify(request.input),
        'utf8',
      );
      const amount = input + request.maxOutputTokens;
      if (this.limits.contextTokens && amount + 512 > this.limits.contextTokens)
        throw new AgentLimitError('模型上下文达到上限');
      if (
        this.state.calls >= this.limits.calls - (this.final ? 0 : 1) ||
        this.state.tokens + amount >
          this.limits.tokens - (this.final ? 0 : this.limits.finalReserve) ||
        this.state.activeMs >= this.limits.activeMs
      )
        throw new AgentLimitError();
      const id = String(++this.state.nextReservation);
      this.state.calls++;
      this.state.tokens += amount;
      this.state.estimatedTokens = (this.state.estimatedTokens || 0) + amount;
      this.state.reservations[id] = amount;
      await this.checkpoint();
      return id;
    });
  }
  async settle(id: string, outcome: ModelCallOutcome): Promise<void> {
    await this.serial(async () => {
      const reserved = this.state.reservations[id];
      if (reserved === undefined) return;
      const actual = outcome.usage?.totalTokens;
      if (Number.isFinite(actual) && actual! >= 0) {
        this.state.tokens += actual! - reserved;
        this.state.estimatedTokens = Math.max(0, (this.state.estimatedTokens || 0) - reserved);
        this.state.providerTokens = (this.state.providerTokens || 0) + actual!;
        this.state.providerInputTokens =
          (this.state.providerInputTokens || 0) + (outcome.usage?.inputTokens || 0);
        this.state.providerOutputTokens =
          (this.state.providerOutputTokens || 0) + (outcome.usage?.outputTokens || 0);
      }
      delete this.state.reservations[id];
      await this.checkpoint();
    });
  }
}
