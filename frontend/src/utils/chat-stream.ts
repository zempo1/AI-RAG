import type { SseEvent } from './sse';
import type { AcceptedAnswer, FinalAnswer } from '../api/chat';
import type { Citation } from '../api/knowledge-bases';
import type { AgentStep } from './agent-progress';
export interface StreamChatCallbacks {
  onMessage: (text: string) => void;
  onChatId: (id: number) => void;
  onSources?: (sources: Citation[]) => void;
  onStatus?: (stage: string) => void;
  onAccepted?: (accepted: AcceptedAnswer) => void;
  onAgentStep?: (step: AgentStep) => void;
  onCitations?: (citations: Citation[]) => void;
  onDone: (answer: FinalAnswer) => void;
  onError: (error: unknown) => void;
  onFinish: () => void;
}
/** Return true for a terminal successful frame; shared by the actual fetch reader. */
export function dispatchChatEvent(frame: SseEvent, callbacks: StreamChatCallbacks): boolean {
  const value = JSON.parse(frame.data);
  if (frame.event === 'status') callbacks.onStatus?.(String(value.stage));
  else if (frame.event === 'chatId') callbacks.onChatId(Number(value));
  else if (frame.event === 'agent_step') callbacks.onAgentStep?.(value);
  else if (frame.event === 'accepted') { callbacks.onAccepted?.(value); return true; }
  else if (frame.event === 'sources') callbacks.onSources?.(value);
  else if (frame.event === 'citations') callbacks.onCitations?.(value);
  else if (frame.event === 'done') { callbacks.onDone(value); return true; }
  else if (frame.event === 'error') {
    if (typeof value.answer === 'string') callbacks.onDone(value);
    throw new Error(value.message || '生成失败');
  } else if (frame.event === 'message') callbacks.onMessage(String(value));
  return false;
}
