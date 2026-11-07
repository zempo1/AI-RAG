/** 实现业务处理；所属能力：接收问答请求，连接 RAG 与模型，发送流式事件并保存会话。 */
import { Injectable, Inject } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { LlmService } from '../llm/llm.service';
import { Citation, normalizeCitations, NO_CONTEXT_ANSWER } from '../rag/citations';
export type AnswerEvent =
  | { type: 'sources'; sources: Citation[] }
  | { type: 'message'; text: string }
  | {
      type: 'done';
      answer: string;
      citations: Citation[];
      retrievalRunId?: number;
      diagnostics?: any;
    };
@Injectable()
export class ChatService {
  constructor(
    @Inject(AgentService) private readonly rag: Pick<AgentService, 'prepare'>,
    private readonly llm: LlmService,
  ) {}
  async prepare(question: string, userId: number, kbId?: number, options?: any) {
    return { ...(await this.rag.prepare(question, userId, kbId, options)), userId };
  }
  private prompt(context: any) {
    return (
      context.prompt +
      '\n图片识别结果与模型图解均为文字证据；未提供原图，不声称核对过原图。无法辨认的数字或关系明确说明证据不足，不猜测。'
    );
  }
  private metadata(context: any) {
    return context.diagnostics
      ? { retrievalRunId: context.diagnostics.runId, diagnostics: context.diagnostics }
      : {};
  }
  async answerPrepared(context: any, apiKey?: string, signal?: AbortSignal) {
    if (context.engine === 'agentic-v1')
      return (this.rag as AgentService).answerPrepared(context, apiKey, signal);
    // 文档问答没有证据时直接说明不足；通用问答允许模型使用自身知识回答。
    const answer =
      context.directAnswer ||
      (!context.sources.length && context.diagnostics?.responseType !== 'general'
        ? NO_CONTEXT_ANSWER
        : await this.llm.complete(this.prompt(context), apiKey));
    return { ...normalizeCitations(answer, context.sources), ...this.metadata(context) };
  }
  async chat(question: string, userId: number, kbId?: number, apiKey?: string, options?: any) {
    return this.answerPrepared(await this.prepare(question, userId, kbId, options), apiKey);
  }
  async *streamPrepared(
    context: any,
    apiKey?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AnswerEvent> {
    if (signal?.aborted) return;
    if (context.engine === 'agentic-v1') {
      yield* (this.rag as AgentService).streamPrepared(context, apiKey, signal);
      return;
    }
    yield { type: 'sources', sources: context.sources };
    let answer = '';
    if (
      context.directAnswer ||
      (!context.sources.length && context.diagnostics?.responseType !== 'general')
    ) {
      answer = context.directAnswer || NO_CONTEXT_ANSWER;
      yield { type: 'message', text: answer };
    } else
      for await (const text of this.llm.stream(this.prompt(context), apiKey, signal)) {
        if (signal?.aborted) return;
        answer += text;
        yield { type: 'message', text };
      }
    // 流式片段仅用于即时展示；最终结果统一清理无效引用后再交给调用方保存。
    yield {
      type: 'done',
      ...normalizeCitations(answer, context.sources),
      ...this.metadata(context),
    };
  }
  async *stream(
    question: string,
    userId: number,
    kbId?: number,
    apiKey?: string,
    signal?: AbortSignal,
    options?: any,
  ): AsyncGenerator<AnswerEvent> {
    yield* this.streamPrepared(await this.prepare(question, userId, kbId, options), apiKey, signal);
  }
}
