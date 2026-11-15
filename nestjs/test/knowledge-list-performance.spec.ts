import { jest } from '@jest/globals';
import { MemoryStore } from '../src/persistence/memory.store';
import { KnowledgeBasesService } from '../src/modules/knowledge-bases/knowledge-bases.service';

it('reads an existing default library list once without entering a creation transaction', async () => {
  const store = new MemoryStore();
  await store.save('knowledgeBases', {userId:1,isDefault:1,deletedAt:null});
  await store.save('knowledgeBases', {userId:2,isDefault:1,deletedAt:null});
  const list=jest.spyOn(store,'list'), tx=jest.spyOn(store,'transaction');
  const rows=await new KnowledgeBasesService(store).list(1);
  expect(rows).toHaveLength(1);
  expect(list).toHaveBeenCalledTimes(1);
  expect(tx).not.toHaveBeenCalled();
});
it('still creates a missing default library safely under concurrent list reads', async () => {
  const store = new MemoryStore();
  await store.save('users',{id:1,username:'test'});
  const service = new KnowledgeBasesService(store);
  const [a,b]=await Promise.all([service.list(1),service.list(1)]);
  expect(a).toHaveLength(1); expect(b).toHaveLength(1);
  expect(a[0].id).toBe(b[0].id);
});
