import { Injectable } from '@nestjs/common';
import { Store, publicRow } from '../../persistence/store';
import { ApiError } from '../../common/api-error';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { Citation } from '../rag/citations';

@Injectable()
export class HistoryService {
  constructor(
    private readonly store: Store,
    private readonly libraries: KnowledgeBasesService,
  ) {}

  async get(id: number, userId: number) {
    let chat = await this.store.get('chats', id);
    if (!chat || chat.userId !== userId) throw new ApiError(404, 'Chat not found');
    if (!chat.knowledgeBaseId)
      chat = await this.store.save('chats', {
        id,
        knowledgeBaseId: (await this.libraries.default(userId)).id,
      });
    const kb = await this.store.get('knowledgeBases', chat.knowledgeBaseId);
    const rows = (await this.store.list('messages', { chatId: id })).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id,
    );
    const messages = await Promise.all(
      rows.map(async (row) => {
        const citations = await Promise.all(
          ((row.citations || []) as Citation[]).map(async (citation) => {
            const doc = await this.store.get('documents', citation.documentId);
            return {
              ...citation,
              sourceDeleted: !doc || !!doc.deletedAt || !!kb?.deletedAt,
              sourceOutdated: !!doc && doc.activeVersionId !== citation.versionId,
            };
          }),
        );
        return { ...publicRow(row), citations };
      }),
    );
    return {
      ...publicRow(chat),
      id: chat.id,
      knowledgeBaseId: chat.knowledgeBaseId as number,
      readOnly: !kb || !!kb.deletedAt,
      messages,
    };
  }

  async writable(id: number, userId: number, knowledgeBaseId?: number) {
    const chat = await this.get(id, userId);
    if (chat.readOnly) throw new ApiError(409, '知识库已删除，此会话仅可查看');
    if (knowledgeBaseId != null && chat.knowledgeBaseId !== knowledgeBaseId)
      throw new ApiError(400, '会话知识库不匹配，请新建会话');
    return chat;
  }

  async list(userId: number) {
    const chats = (await this.store.list('chats', { userId })).sort((a, b) => b.id - a.id);
    return Promise.all(chats.map((chat) => this.get(chat.id, userId)));
  }

  async create(title: string, userId: number, knowledgeBaseId?: number) {
    const kb = await this.libraries.resolve(userId, knowledgeBaseId);
    const chat = await this.store.save('chats', { title, userId, knowledgeBaseId: kb.id });
    return {
      ...publicRow(chat),
      id: chat.id,
      knowledgeBaseId: kb.id as number,
      readOnly: false,
      messages: [],
    };
  }

  async addMessage(
    chatId: number,
    userId: number,
    role: string,
    content: string,
    citations: Citation[] = [],
    generationStatus = 'completed',
  ): Promise<void> {
    // Historical writes from a request that began before deletion are allowed to settle.
    const chat = await this.store.get('chats', chatId);
    if (!chat || chat.userId !== userId) throw new ApiError(404, 'Chat not found');
    await this.store.save('messages', { chatId, role, content, citations, generationStatus });
  }

  async delete(id: number, userId: number): Promise<void> {
    await this.get(id, userId);
    await this.store.transaction(async (tx) => {
      for (const message of await tx.list('messages', { chatId: id }))
        await tx.delete('messages', message.id);
      await tx.delete('chats', id);
    });
  }
}
