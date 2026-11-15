import { jest } from '@jest/globals';
import { MemoryStore } from '../src/persistence/memory.store';
import { HistoryService } from '../src/modules/history/history.service';
import { KnowledgeBasesService } from '../src/modules/knowledge-bases/knowledge-bases.service';

async function fixture() {
  const store = new MemoryStore();
  const kb = await store.save('knowledgeBases', { userId: 1, deletedAt: null });
  const chat = await store.save('chats', { userId: 1, knowledgeBaseId: kb.id, title: '标题' });
  const doc = await store.save('documents', { userId: 1, activeVersionId: 2 });
  await store.save('messages', { chatId: chat.id, role: 'assistant', content: '历史正文',
    citations: Array.from({length: 100}, () => ({ documentId: doc.id, versionId: 1, text: '原文快照' })) });
  return { store, kb, chat, history: new HistoryService(store, new KnowledgeBasesService(store)) };
}
it('lists only scoped sidebar metadata without loading messages, citations or tasks', async () => {
  const {store, kb, history} = await fixture();
  await store.save('chats', {userId: 2, title: '其他用户'});
  const list = jest.spyOn(store, 'list'), get = jest.spyOn(store, 'get');
  const result = await history.list(1);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({title:'标题', readOnly:false});
  expect(result[0]).not.toHaveProperty('messages');
  expect(result[0]).not.toHaveProperty('pendingTasks');
  expect(list.mock.calls.every(([table]) => ['chats','knowledgeBases'].includes(table))).toBe(true);
  expect(get).not.toHaveBeenCalled();
  await store.save('knowledgeBases', {id:kb.id, deletedAt:'deleted'});
  expect((await history.list(1))[0].readOnly).toBe(true);
});
it('loads full detail on demand but reads each cited document only once', async () => {
  const {store, chat, history} = await fixture();
  const get = jest.spyOn(store, 'get');
  const result = await history.get(chat.id, 1);
  expect(result.messages[0].citations).toHaveLength(100);
  expect(result.messages[0].citations[0]).toMatchObject({text:'原文快照', sourceOutdated:true});
  expect(get.mock.calls.filter(([table]) => table === 'documents')).toHaveLength(1);
  await expect(history.get(chat.id, 2)).rejects.toMatchObject({status:404});
});
