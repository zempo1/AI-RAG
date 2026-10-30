import { Injectable } from '@nestjs/common';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { VectorStore } from '../vector-store/vector-store.interface';

@Injectable()
export class RagService {
  constructor(
    private readonly embeddings: EmbeddingsService,
    private readonly vectors: VectorStore,
  ) {}

  async prompt(question: string, userId: number): Promise<string> {
    const vector = await this.embeddings.embedQuery(question);
    const matches = this.vectors
      .search(vector, 10, 0.5)
      .filter((m) => m.segment.userId === userId)
      .slice(0, 5);
    if (!matches.length) return question;
    return (
      "You are a helpful assistant. Answer the user's question based strictly on the context provided below.\n" +
      "If the answer is not in the context, say you don't know.\n\n" +
      'Context:\n' +
      matches.map((m) => m.segment.text).join('\n\n') +
      '\n\nQuestion: ' +
      question
    );
  }
}
