import { MemoryStore } from '../src/persistence/memory.store';
import { KnowledgeBasesService } from '../src/modules/knowledge-bases/knowledge-bases.service';

describe('private knowledge bases', () => {
  let store: MemoryStore;
  let service: KnowledgeBasesService;
  beforeEach(() => {
    store = new MemoryStore();
    service = new KnowledgeBasesService(store);
  });

  it('creates one default library even with concurrent requests', async () => {
    const libraries = await Promise.all([service.default(1), service.default(1)]);
    expect(libraries[0].id).toBe(libraries[1].id);
    expect(await service.list(1)).toHaveLength(1);
    expect(await service.list(2)).toHaveLength(1);
    await expect(service.owned(libraries[0].id, 2)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps categories in their library and moves documents to uncategorized on deletion', async () => {
    const a = await service.create(1, '学习资料');
    const b = await service.create(1, '技术资料');
    const category = await service.createCategory(a.id, 1, '数据库');
    await expect(service.category(b.id, category.id, 1)).rejects.toMatchObject({ status: 404 });
    const doc = await store.save('documents', {
      userId: 1,
      knowledgeBaseId: a.id,
      categoryId: category.id,
      filename: 'a.md',
    });
    await service.deleteCategory(a.id, category.id, 1);
    expect((await store.get('documents', doc.id))?.categoryId).toBeNull();
    expect(await service.categories(a.id, 1)).toEqual([]);
  });

  it('does not accept mutations in a deleted library or writes during a rebuild', async () => {
    const kb = await service.create(1, '资料');
    await store.save('knowledgeBases', { id: kb.id, rebuildTaskId: 7 });
    await expect(store.transaction((tx) => service.writable(tx, kb.id, 1))).rejects.toMatchObject({
      status: 409,
    });
    await store.save('knowledgeBases', { id: kb.id, deletedAt: '2026-10-31T00:00:00' });
    await expect(service.owned(kb.id, 1)).rejects.toMatchObject({ status: 404 });
  });
});
