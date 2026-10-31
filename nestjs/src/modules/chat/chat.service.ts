import { Injectable } from '@nestjs/common';
import { RagService } from '../rag/rag.service';
import { LlmService } from '../llm/llm.service';
import { Citation, normalizeCitations, NO_CONTEXT_ANSWER } from '../rag/citations';

export type AnswerEvent =
  | { type: 'sources'; sources: Citation[] }
  | { type: 'message'; text: string }
  | { type: 'done'; answer: string; citations: Citation[] };

@Injectable()
export class ChatService {
  constructor(
    private readonly rag: RagService,
    private readonly llm: LlmService,
  ) {}

  async chat(question: string, userId: number, knowledgeBaseId?: number, apiKey?: string) {
    const context = await this.rag.prepare(question, userId, knowledgeBaseId);
    if (!context.sources.length) return { answer: NO_CONTEXT_ANSWER, citations: [] };
    return normalizeCitations(await this.llm.complete(context.prompt, apiKey), context.sources);
  }

  async *stream(
    question: string,
    userId: number,
    knowledgeBaseId?: number,
    apiKey?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AnswerEvent> {
    const context = await this.rag.prepare(question, userId, knowledgeBaseId);
    if (signal?.aborted) return;
    yield { type: 'sources', sources: context.sources };
    let answer = '';
    if (!context.sources.length) {
      answer = NO_CONTEXT_ANSWER;
      yield { type: 'message', text: answer };
    } else {
      for await (const text of this.llm.stream(context.prompt, apiKey, signal)) {
        if (signal?.aborted) return;
        answer += text;
        yield { type: 'message', text };
      }
    }
    yield { type: 'done', ...normalizeCitations(answer, context.sources) };
  }
}
