import { MemoryStore } from '../src/persistence/memory.store';
import { DocumentsService } from '../src/modules/documents/documents.service';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';
import { RecursiveChunker } from '../src/modules/documents/chunkers/recursive.chunker';
import { InMemoryVectorStore } from '../src/modules/vector-store/in-memory-vector-store.service';

it('deletes only associated results and vectors, preserving same-name and legacy maps', async () => {
  const store = new MemoryStore();
  const vectors = new InMemoryVectorStore();
  const service = new DocumentsService(
    store,
    new DocumentParser(),
    new RecursiveChunker(),
    {
      embedDocuments: async () => [[1, 0]],
    } as any,
    vectors,
  );
  const doc = await service.ingest(Buffer.from('正文'), 'same.md', 1);
  const other = await service.ingest(Buffer.from('另一个文件'), 'same.md', 2);
  for (const type of ['SUMMARY', 'OUTLINE', 'FLASHCARD']) {
    await store.save('analyses', { documentId: doc.id, userId: 1, type });
  }
  await store.save('mindmaps', { documentId: doc.id, userId: 1 });
  await store.save('mindmaps', { documentId: other.id, userId: 2 });
  await store.save('mindmaps', { userId: 1, title: 'same.md - Mind Map' });
  await expect(service.delete(doc.id, 2)).rejects.toThrow();
  await service.delete(doc.id, 1);
  expect(await store.get('documents', doc.id)).toBeUndefined();
  expect(await store.list('analyses')).toHaveLength(0);
  expect(await store.list('mindmaps')).toHaveLength(2);
  expect(vectors.search([1, 0], 10, 0).map((m) => m.segment.documentId)).toEqual([other.id]);
});
