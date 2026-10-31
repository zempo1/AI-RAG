import { Injectable } from '@nestjs/common';
import { Store, Row } from '../../persistence/store';
import { ApiError } from '../../common/api-error';

@Injectable()
export class KnowledgeBasesService {
  constructor(private readonly store: Store) {}

  async default(userId: number): Promise<Row> {
    return this.store.transaction(async (tx) => {
      await tx.lock('users', userId);
      const existing = (await tx.list('knowledgeBases', { userId })).find(
        (k) => k.isDefault === 1 && !k.deletedAt,
      );
      return (
        existing ||
        tx.save('knowledgeBases', {
          userId,
          name: '默认知识库',
          description: '',
          isDefault: 1,
          rebuildTaskId: null,
          deletedAt: null,
        })
      );
    });
  }

  async resolve(userId: number, id?: number | null): Promise<Row> {
    return id == null ? this.default(userId) : this.owned(id, userId);
  }

  async owned(id: number, userId: number, tx = this.store): Promise<Row> {
    const kb = await tx.get('knowledgeBases', id);
    if (!kb || kb.userId !== userId || kb.deletedAt) throw new ApiError(404, '知识库不存在');
    return kb;
  }

  async writable(tx: Store, id: number, userId: number): Promise<Row> {
    const kb = await tx.lock('knowledgeBases', id);
    if (!kb || kb.userId !== userId || kb.deletedAt) throw new ApiError(404, '知识库不存在');
    if (kb.rebuildTaskId) throw new ApiError(409, '知识库正在重建，请稍后再修改文档');
    return kb;
  }

  async list(userId: number) {
    await this.default(userId);
    return (await this.store.list('knowledgeBases', { userId })).filter((k) => !k.deletedAt);
  }

  create(userId: number, name: string, description = '') {
    return this.store.save('knowledgeBases', {
      userId,
      name: this.name(name),
      description,
      isDefault: null,
      rebuildTaskId: null,
      deletedAt: null,
    });
  }

  async update(id: number, userId: number, name: string, description = '') {
    return this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', id);
      await this.owned(id, userId, tx);
      return tx.save('knowledgeBases', { id, name: this.name(name), description });
    });
  }

  async categories(id: number, userId: number) {
    await this.owned(id, userId);
    return this.store.list('categories', { knowledgeBaseId: id });
  }

  async category(kbId: number, categoryId: number, userId: number, tx = this.store) {
    await this.owned(kbId, userId, tx);
    const category = await tx.get('categories', categoryId);
    if (!category || category.knowledgeBaseId !== kbId) throw new ApiError(404, '分类不存在');
    return category;
  }

  async createCategory(id: number, userId: number, name: string) {
    return this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', id);
      await this.owned(id, userId, tx);
      name = this.name(name);
      if ((await tx.list('categories', { knowledgeBaseId: id, name })).length)
        throw new ApiError(409, '分类已存在');
      return tx.save('categories', { knowledgeBaseId: id, name });
    });
  }

  async updateCategory(kbId: number, id: number, userId: number, name: string) {
    return this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', kbId);
      await this.category(kbId, id, userId, tx);
      name = this.name(name);
      if ((await tx.list('categories', { knowledgeBaseId: kbId, name })).some((c) => c.id !== id))
        throw new ApiError(409, '分类已存在');
      return tx.save('categories', { id, name });
    });
  }

  async deleteCategory(kbId: number, id: number, userId: number) {
    await this.store.transaction(async (tx) => {
      await tx.lock('knowledgeBases', kbId);
      await this.category(kbId, id, userId, tx);
      for (const doc of await tx.list('documents', { knowledgeBaseId: kbId, categoryId: id })) {
        await tx.save('documents', { id: doc.id, categoryId: null });
      }
      await tx.delete('categories', id);
    });
  }

  private name(value: string) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 120)
      throw new ApiError(400, '名称须为 1～120 个字符');
    return value.trim();
  }
}
