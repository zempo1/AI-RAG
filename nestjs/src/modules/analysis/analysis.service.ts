import { Injectable } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { LlmService } from '../llm/llm.service';
import { Store, publicRow } from '../../persistence/store';
import { analysisPrompt } from './prompts';
import { ApiError } from '../../common/api-error';

@Injectable()
export class AnalysisService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly llm: LlmService,
    private readonly store: Store,
  ) {}

  async generate(documentId: number, type: string, userId: number, apiKey?: string) {
    const doc = await this.documents.ready(documentId, userId);
    const result = (
      await this.llm.complete(analysisPrompt(type, doc.content.slice(0, 20000)), apiKey)
    ).trim();
    if (!result) throw new ApiError(500, '模型返回空内容');
    if (type === 'FLASHCARD') {
      let cards: any;
      try {
        cards = JSON.parse(result);
      } catch {
        throw new ApiError(500, '模型返回无效的闪卡 JSON');
      }
      if (
        !Array.isArray(cards) ||
        !cards.length ||
        cards.some((c) => !c || typeof c.q !== 'string' || typeof c.a !== 'string')
      )
        throw new ApiError(500, '模型返回无效的闪卡结构');
    }
    return publicRow(
      await this.store.transaction(async (tx) => {
        const kb = await tx.lock('knowledgeBases', doc.knowledgeBaseId);
        const source = await tx.lock('documents', documentId);
        if (!kb || kb.deletedAt || !source || source.userId !== userId || source.deletedAt)
          throw new ApiError(500, 'Document not found: ' + documentId);
        return tx.save('analyses', {
          userId,
          documentId,
          versionId: doc.activeVersionId,
          documentName: doc.filename,
          type,
          content: result,
        });
      }),
    );
  }

  async list(type: string, userId: number) {
    return Promise.all(
      (await this.store.list('analyses', { type, userId }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
        .map(async (row) => {
          const source = row.documentId ? await this.store.get('documents', row.documentId) : null;
          return {
            ...publicRow(row),
            sourceOutdated: !!source && row.versionId !== source.activeVersionId,
          };
        }),
    );
  }

  async delete(id: number, userId: number): Promise<void> {
    const row = await this.store.get('analyses', id);
    if (!row || row.userId !== userId) throw new ApiError(500, 'Analysis not found: ' + id);
    await this.store.delete('analyses', id);
  }
}
