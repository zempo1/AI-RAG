import { join } from 'node:path';
import { IndexingService } from '../src/modules/documents/indexing.service';
import { RecursiveChunker } from '../src/modules/documents/chunkers/recursive.chunker';
import { PageAssetsService } from '../src/modules/documents/page-assets.service';
import { paragraphBlocks, ParsedDocument } from '../src/modules/documents/parsers/parsed-document';
import type { ParseContext } from '../src/modules/documents/parsers/pdf-visual.service';
import { TokenizerService } from '../src/modules/embeddings/tokenizer.service';
import { currentModelProfile } from '../src/modules/embeddings/model-profile';
import { pipeline } from './helpers/pipeline';

const page = (number: number, visual = false): ParsedDocument => {
  const native = `第 ${number} 页的可检索正文。`;
  const table = '[表格识别]\n列：值';
  const blocks = paragraphBlocks(native, number);
  blocks[0].location.contentType = 'native';
  if (!visual) return { text: native, blocks };
  const text = native + '\n\n' + table;
  blocks.push({
    text: table,
    contextText: native,
    location: {
      page: number,
      heading: null,
      paragraph: null,
      start: native.length + 2,
      end: text.length,
      contentType: 'table',
      relatedParagraphs: [1],
    },
  });
  return { text, blocks };
};
const vector = [1, ...Array(255).fill(0)];

async function setup(
  parser: {
    parsePages: (input: Uint8Array, context: ParseContext) => AsyncGenerator<ParsedDocument>;
  },
  embed: (texts: string[], profile: unknown, signal?: AbortSignal) => Promise<number[][]>,
) {
  const p = await pipeline();
  p.config.set('EMBEDDING_PROVIDER', 'dashscope');
  p.config.set('EMBEDDING_DIMENSIONS', 256);
  p.config.set('PAGE_ASSETS_DIR', join(p.config.getOrThrow<string>('ORIGINALS_DIR'), 'pages'));
  const chunker = new RecursiveChunker();
  const indexing = new IndexingService(
    p.store,
    {
      ...parser,
      parseStructured: async () => {
        throw new Error('PDF indexing must consume the page stream');
      },
    } as any,
    chunker,
    { embedDocuments: embed } as any,
    p.vectors,
    p.tasks,
    p.config,
    new PageAssetsService(p.config, p.store),
  );
  const accepted = await p.documents.ingest(Buffer.from('%PDF-test'), 'stream.pdf', 1);
  return { ...p, indexing, accepted, chunker };
}

it('embeds while pages are still being parsed and publishes ordered global offsets', async () => {
  let ready = 0;
  let active = 0;
  let peak = 0;
  let firstStarted!: () => void;
  const firstBatchStarted = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const batches: number[] = [];
  const p = await setup(
    {
      async *parsePages(_input, context) {
        for (let i = 1; i <= 22; i++) {
          if (i === 11) await firstBatchStarted;
          ready++;
          await context.progress?.({ pages: i, totalPages: 22, regions: 0, totalRegions: 0 });
          yield page(i, i === 12);
        }
      },
    },
    async (texts) => {
      if (!batches.length) {
        firstStarted();
        expect(ready).toBe(10);
      }
      batches.push(texts.length);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return texts.map(() => vector);
    },
  );
  try {
    await p.indexing.process(p.accepted.taskId);
    expect(batches).toEqual([10, 10, 3]);
    expect(peak).toBe(2);
    expect((await p.tasks.get(p.accepted.taskId, 1)).indexProgress).toEqual({
      pages: { completed: 22, total: 22 },
      regions: { completed: 0, total: 0 },
      embedding: { completed: 23, total: 23 },
      indexing: { completed: 23, total: 23 },
    });
    const doc = await p.documents.owned(p.accepted.documentId, 1);
    const chunks = (
      await p.store.list('chunks', { indexRevisionId: doc.activeIndexRevisionId })
    ).sort((a, b) => a.chunkIndex - b.chunkIndex);
    const pages = Array.from({ length: 22 }, (_, i) => page(i + 1, i === 11));
    let offset = 0;
    const blocks = pages.flatMap((part) => {
      const value = part.blocks.map((block) => ({
        ...block,
        location: {
          ...block.location,
          start: block.location.start + offset,
          end: block.location.end + offset,
        },
      }));
      offset += part.text.length + 1;
      return value;
    });
    const text = pages.map((part) => part.text).join('\n');
    expect(doc.content).toBe(text);
    expect(
      chunks.map(({ text, location, retrievalMetadata }) => ({
        text,
        location,
        retrievalMetadata,
      })),
    ).toEqual(
      await p.chunker.splitTokenStructured(
        { text, blocks },
        new TokenizerService(p.config),
        currentModelProfile(p.config),
      ),
    );
  } finally {
    await p.cleanup();
  }
});

it('aborts a running embedding when its document is deleted and never publishes it', async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let canceled = false;
  const p = await setup(
    {
      async *parsePages() {
        yield page(1);
      },
    },
    async (_texts, _profile, signal) => {
      expect(signal).toBeDefined();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener(
          'abort',
          () => {
            canceled = true;
            reject(signal!.reason);
          },
          { once: true },
        );
        started();
      });
      return [vector];
    },
  );
  try {
    const processing = p.indexing.process(p.accepted.taskId);
    await running;
    await p.documents.delete(p.accepted.documentId, 1);
    await processing;
    expect(canceled).toBe(true);
    expect((await p.tasks.get(p.accepted.taskId, 1)).status).toBe('canceled');
    expect(p.vectors.search(vector, 30, 0)).toHaveLength(0);
  } finally {
    await p.cleanup();
  }
});

it('keeps a failed revision hidden and reuses successful vectors while writing the retry', async () => {
  let fail = true;
  let modelCalls = 0;
  const p = await setup(
    {
      async *parsePages() {
        for (let i = 1; i <= 21; i++) yield page(i);
      },
    },
    async (texts) => {
      modelCalls++;
      if (fail && texts[0].includes('第 11 页')) throw new Error('simulated embedding failure');
      return texts.map(() => vector);
    },
  );
  try {
    await expect(p.indexing.process(p.accepted.taskId)).rejects.toThrow(
      'simulated embedding failure',
    );
    expect((await p.documents.owned(p.accepted.documentId, 1)).activeIndexRevisionId).toBeNull();
    expect(modelCalls).toBe(2);
    await p.store.save('tasks', { id: p.accepted.taskId, payload: { indexProgress: {
      pages: { completed: 11, total: 21 }, regions: { completed: 5, total: null },
      embedding: { completed: 10, total: null }, indexing: { completed: 10, total: null },
    } } });
    fail = false;
    const progress: object[] = [];
    await p.indexing.process(p.accepted.taskId, 2, async (event) => { progress.push(event); });
    expect(progress[0]).toMatchObject({ indexProgress: {
      pages: { completed: 0, total: 21 }, previousRecognition: { pages: 11, regions: 5 },
      indexing: { completed: 0 },
    } });
    expect(modelCalls).toBe(4);
    expect(p.vectors.search(vector, 30, 0)).toHaveLength(21);
    expect((await p.tasks.get(p.accepted.taskId, 1)).status).toBe('completed');
  } finally {
    await p.cleanup();
  }
});
