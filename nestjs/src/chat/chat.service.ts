import { Injectable } from '@nestjs/common';
import { RagService } from '../rag/rag.service';
import { LlmService } from '../llm/llm.service';

@Injectable()
export class ChatService {
  constructor(
    private readonly rag: RagService,
    private readonly llm: LlmService,
  ) {}

  async chat(question: string, userId: number): Promise<string> {
    return this.llm.complete(await this.rag.prompt(question, userId));
  }

  async *stream(question: string, userId: number, apiKey?: string, signal?: AbortSignal) {
    const prompt = await this.rag.prompt(question, userId);
    if (signal?.aborted) return;
    yield* this.llm.stream(prompt, apiKey, signal);
  }
}
