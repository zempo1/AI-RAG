export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export type ToolMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; content: string; tool_call_id: string };
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}
export interface ModelCallRequest {
  kind: 'complete' | 'stream' | 'tools';
  model: string;
  /** Local budget estimation only; callers must not persist prompts or credentials in traces. */
  input: unknown;
  maxOutputTokens: number;
}
export interface ModelCallOutcome {
  status: 'success' | 'error' | 'cancelled';
  /** Missing usage means unknown; it must not be counted as a zero-token call. */
  usage?: ModelUsage;
  error?: unknown;
}
export interface ModelCallObserver {
  /** Reserve and await durable checkpoint before allowing the remote request. Unique per call. */
  before(request: ModelCallRequest): Promise<string>;
  /** Called once per successful reservation, including provider/validation failures. Errors propagate. */
  settle(reservationId: string, outcome: ModelCallOutcome): Promise<void>;
}
export interface ModelExecutionOptions {
  signal?: AbortSignal;
  observer?: ModelCallObserver;
  model?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}
export interface ToolInvocationOptions extends ModelExecutionOptions { apiKey?: string }
export interface ToolInvocationResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: ModelUsage;
  finishReason?: string;
}
