import { validateConfig } from '../src/config/configuration';
import { RecursiveChunker } from '../src/documents/chunkers/recursive.chunker';
import { InMemoryVectorStore } from '../src/vector-store/in-memory-vector-store.service';
import { RagService } from '../src/rag/rag.service';

describe('configuration', () => {
  it('defaults to mysql and rejects missing database secrets', () => {
    expect(() => validateConfig({})).toThrow('DB_PASSWORD');
    expect(validateConfig({ STORAGE_DRIVER: 'memory', JWT_SECRET: 'x'.repeat(32) }).PORT).toBe(
      8080,
    );
    expect(() =>
      validateConfig({ STORAGE_DRIVER: 'memory', JWT_SECRET: 'x'.repeat(32), PORT: '0' }),
    ).toThrow('PORT');
  });
});

describe('recursive chunking', () => {
  it('preserves a short Markdown document', () => {
    expect(new RecursiveChunker().split('# 标题\n\n中文内容')).toEqual(['# 标题\n\n中文内容']);
  });
  it('bounds unbroken text with a 50 character overlap', () => {
    const text = Array.from({ length: 950 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
    const chunks = new RecursiveChunker().split(text);
    expect(chunks.map((x) => x.length)).toEqual([500, 500]);
    expect(chunks[0].slice(-50)).toBe(chunks[1].slice(0, 50));
    expect(chunks.join('')).toContain(text.slice(-450));
  });
});

describe('vector storage and RAG', () => {
  const segment = (text: string, userId: number) => ({
    text,
    userId,
    documentId: 1,
    filename: 'a.md',
    chunkIndex: 0,
  });
  it('normalizes cosine scores, ranks and rejects dimension mismatches atomically', () => {
    const store = new InMemoryVectorStore();
    store.addAll(
      [
        [1, 0],
        [0, 1],
        [-1, 0],
      ],
      [segment('a', 1), segment('b', 1), segment('c', 2)],
    );
    expect(store.search([1, 0], 10, 0.5).map((x) => [x.segment.text, x.score])).toEqual([
      ['a', 1],
      ['b', 0.5],
    ]);
    expect(() => store.addAll([[1, 0], [1]], [segment('d', 1), segment('e', 1)])).toThrow();
    expect(store.search([1, 0], 10, 0).length).toBe(3);
  });
  it('builds the original context prompt and falls back to the question', async () => {
    const store = new InMemoryVectorStore();
    store.addAll([[1, 0]], [segment('知识内容', 1)]);
    const rag = new RagService({ embedQuery: async () => [1, 0] } as any, store);
    expect(await rag.prompt('问题', 1)).toBe(
      "You are a helpful assistant. Answer the user's question based strictly on the context provided below.\nIf the answer is not in the context, say you don't know.\n\nContext:\n知识内容\n\nQuestion: 问题",
    );
    expect(await rag.prompt('问题', 2)).toBe('问题');
  });
});
