import { Injectable } from '@nestjs/common';
import { RagService } from '../rag/rag.service';
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
    private readonly rag: RagService,
    private readonly llm: LlmService,
  ) {}
  prepare(question: string, userId: number, kbId?: number, options?: any) {
    return this.rag.prepare(question, userId, kbId, options);
  }
  private metadata(context: any) {
    return context.diagnostics
      ? { retrievalRunId: context.diagnostics.runId, diagnostics: context.diagnostics }
      : {};
  }
  async answerPrepared(context: any, apiKey?: string) {
    const answer =
      context.directAnswer ||
      ((!context.sources.length && context.diagnostics?.responseType !== 'general')
        ? NO_CONTEXT_ANSWER
        : await this.llm.complete(context.prompt, apiKey));
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
    yield { type: 'sources', sources: context.sources };
    let answer = '';
    if (context.directAnswer || (!context.sources.length && context.diagnostics?.responseType !== 'general')) {
      answer = context.directAnswer || NO_CONTEXT_ANSWER;
      yield { type: 'message', text: answer };
    } else
      for await (const text of this.llm.stream(context.prompt, apiKey, signal)) {
        if (signal?.aborted) return;
        answer += text;
        yield { type: 'message', text };
      }
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
