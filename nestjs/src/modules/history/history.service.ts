import { Injectable } from '@nestjs/common';
import { Store, publicRow } from '../../persistence/store';
import { ApiError } from '../../common/api-error';

@Injectable()
export class HistoryService {
  constructor(private readonly store: Store) {}

  async get(id: number, userId: number) {
    const chat = await this.store.get('chats', id);
    if (!chat || chat.userId !== userId) throw new ApiError(404, 'Chat not found');
    const messages = (await this.store.list('messages', { chatId: id }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
      .map(publicRow);
    return { ...publicRow(chat), messages };
  }

  async list(userId: number) {
    const chats = (await this.store.list('chats', { userId })).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
    );
    return Promise.all(chats.map((chat) => this.get(chat.id, userId)));
  }

  async create(title: string, userId: number) {
    const chat = await this.store.save('chats', { title, userId });
    return { ...publicRow(chat), id: chat.id, messages: [] };
  }

  async addMessage(chatId: number, userId: number, role: string, content: string): Promise<void> {
    await this.get(chatId, userId);
    await this.store.save('messages', { chatId, role, content });
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
