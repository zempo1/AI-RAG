import { Injectable } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { LlmService } from '../llm/llm.service';
import { Store, publicRow } from '../../persistence/store';
import { mindMapPrompt } from '../analysis/prompts';
import { ApiError } from '../../common/api-error';

function validate(data: string): void {
  let json: any;
  try {
    json = JSON.parse(data);
  } catch {
    throw new ApiError(500, '模型返回无效的思维导图 JSON');
  }
  const node = (n: any, depth = 0): boolean =>
    depth < 100 &&
    !!n &&
    typeof n.data?.text === 'string' &&
    (n.children === undefined ||
      (Array.isArray(n.children) && n.children.every((c: any) => node(c, depth + 1))));
  if (!node(json.root)) throw new ApiError(500, '思维导图结构无效');
}

@Injectable()
export class MindMapsService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly llm: LlmService,
    private readonly store: Store,
  ) {}

  async generate(userId: number, documentId?: number | null, apiKey?: string) {
    const doc =
      documentId == null
        ? await this.documents.latest(userId)
        : await this.documents.ready(documentId, userId);
    const response = await this.llm.complete(mindMapPrompt(doc.content.slice(0, 20000)), apiKey);
    const data = (response.match(/\{[\s\S]*\}/)?.[0] || response).trim();
    validate(data);
    return publicRow(
      await this.store.transaction(async (tx) => {
        const kb = await tx.lock('knowledgeBases', doc.knowledgeBaseId);
        const source = await tx.lock('documents', doc.id);
        if (!kb || kb.deletedAt || !source || source.userId !== userId || source.deletedAt)
          throw new ApiError(500, 'Document not found: ' + doc.id);
        return tx.save('mindmaps', {
          userId,
          documentId: doc.id,
          versionId: doc.activeVersionId,
          title: doc.filename + ' - Mind Map',
          data,
        });
      }),
    );
  }

  async owned(id: number, userId: number) {
    const row = await this.store.get('mindmaps', id);
    if (!row || row.userId !== userId) throw new ApiError(500, 'Mind Map not found');
    return row;
  }

  async get(id: number, userId: number) {
    const row = await this.owned(id, userId);
    const doc = row.documentId ? await this.store.get('documents', row.documentId) : null;
    return { ...publicRow(row), sourceOutdated: !!doc && row.versionId !== doc.activeVersionId };
  }

  async list(userId: number) {
    return Promise.all(
      (await this.store.list('mindmaps', { userId }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
        .map((row) => this.get(row.id, userId)),
    );
  }

  async update(id: number, userId: number, data: string) {
    const row = await this.owned(id, userId);
    return publicRow(await this.store.save('mindmaps', { ...row, data }));
  }

  async delete(id: number, userId: number): Promise<void> {
    await this.owned(id, userId);
    await this.store.delete('mindmaps', id);
  }
}
