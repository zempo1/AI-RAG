import { DocumentsService } from '../src/modules/documents/documents.service';
import { MemoryStore } from '../src/persistence/memory.store';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';
import { RecursiveChunker } from '../src/modules/documents/chunkers/recursive.chunker';
import { InMemoryVectorStore } from '../src/modules/vector-store/in-memory-vector-store.service';

describe('document activation reuse', () => {
  it('reuses indexed documents without duplicating vectors and checks ownership', async () => {
    const store = new MemoryStore();
    const vectors = new InMemoryVectorStore();
    let calls = 0;
    const service = new DocumentsService(
      store,
      new DocumentParser(),
      new RecursiveChunker(),
      {
        embedDocuments: async (texts: string[]) => {
          calls++;
          return texts.map(() => [1, 0]);
        },
      } as any,
      vectors,
    );
    const doc = await service.ingest(Buffer.from('内容'), 'a.md', 1);
    await service.activate(doc.id, 1);
    await service.activate(doc.id, 1);
    expect(calls).toBe(1);
    expect(vectors.search([1, 0], 10, 0)).toHaveLength(1);
    await expect(service.activate(doc.id, 2)).rejects.toThrow('Document not found');
  });
  it('coalesces concurrent activations and retries failed indexing', async () => {
    const store = new MemoryStore();
    const doc = await store.save('documents', {
      userId: 1,
      filename: 'old.md',
      content: '历史内容',
    });
    let calls = 0;
    let fail = true;
    const service = new DocumentsService(
      store,
      new DocumentParser(),
      new RecursiveChunker(),
      {
        embedDocuments: async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (fail) throw new Error('failed');
          return [[1, 0]];
        },
      } as any,
      new InMemoryVectorStore(),
    );
    await expect(service.activate(doc.id, 1)).rejects.toThrow('failed');
    fail = false;
    await Promise.all([service.activate(doc.id, 1), service.activate(doc.id, 1)]);
    expect(calls).toBe(2);
    await service.activate(doc.id, 1);
    expect(calls).toBe(2);
  });
});
