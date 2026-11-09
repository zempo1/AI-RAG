import PDFDocument from 'pdfkit';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';

const scope = { userId: 1, documentId: 1, versionId: 1 };

async function pdf(count: number): Promise<Buffer> {
  const document = new PDFDocument();
  const pieces: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => {
    document.on('data', (piece) => pieces.push(piece));
    document.on('end', () => resolve(Buffer.concat(pieces)));
  });
  for (let n = 1; n <= count; n++) {
    if (n > 1) document.addPage();
    document.text('Native page ' + n);
  }
  document.end();
  return bytes;
}

it('yields local page offsets in order with at most two pages ahead of the consumer', async () => {
  const bytes = await pdf(5);
  const prepared: number[] = [];
  const hashes = new Set<string>();
  let unblockFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    unblockFirst = resolve;
  });
  let thirdPrepared!: () => void;
  const ready = new Promise<void>((resolve) => {
    thirdPrepared = resolve;
  });
  const parser = new DocumentParser({
    enabled: true,
    concurrency: 8,
    page: async (_document: any, page: any, _text: string, context: any) => {
      prepared.push(page.pageNumber);
      hashes.add(context.sourceHash);
      if (prepared.length === 3) thirdPrepared();
      if (page.pageNumber === 1) await firstBlocked;
      return { blocks: [] };
    },
  } as any);
  const pages = parser.parsePages(bytes, scope);
  const first = pages.next();
  await ready;
  expect(prepared.sort()).toEqual([1, 2, 3]);
  unblockFirst();
  const page = (await first).value!;
  expect(page.text).toBe('Native page 1');
  expect(prepared).toHaveLength(3);
  const outputs = [page];
  for await (const result of pages) outputs.push(result);
  expect(outputs.map((result) => result.blocks[0].location.page)).toEqual([1, 2, 3, 4, 5]);
  for (const result of outputs)
    for (const block of result.blocks)
      expect(result.text.slice(block.location.start, block.location.end)).toBe(block.text);
  expect([...hashes]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  const collected = await parser.parseStructured(bytes, 'a.pdf', undefined, scope);
  expect(collected.text).toBe(outputs.map((result) => result.text).join('\n'));
  for (const block of collected.blocks)
    expect(collected.text.slice(block.location.start, block.location.end)).toBe(block.text);
});

it('settles already issued page work when its consumer returns early', async () => {
  const bytes = await pdf(5);
  const pending = new Set<number>();
  const prepared: number[] = [];
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const parser = new DocumentParser({
    enabled: true,
    concurrency: 3,
    page: async (_document: any, page: any) => {
      const number = page.pageNumber;
      prepared.push(number);
      if (number !== 1) {
        pending.add(number);
        await blocked;
        pending.delete(number);
      }
      return { blocks: [] };
    },
  } as any);
  const pages = parser.parsePages(bytes, scope);
  await pages.next();
  const close = pages.return(undefined);
  unblock();
  await close;
  expect(pending.size).toBe(0);
  expect(prepared.every((number) => number <= 3)).toBe(true);
});

it('propagates cancellation to active recognition and preserves the task error', async () => {
  const bytes = await pdf(4);
  const controller = new AbortController();
  const canceled = new Error('index superseded');
  let active = 0;
  let issued!: () => void;
  const ready = new Promise<void>((resolve) => {
    issued = resolve;
  });
  const parser = new DocumentParser({
    enabled: true,
    concurrency: 3,
    page: async (_document: any, _page: any, _text: string, context: any) => {
      active++;
      if (active === 3) issued();
      try {
        await new Promise<void>((_, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          });
        });
      } finally {
        active--;
      }
    },
  } as any);
  const pages = parser.parsePages(bytes, { ...scope, signal: controller.signal });
  const first = pages.next();
  await ready;
  controller.abort(canceled);
  await expect(first).rejects.toBe(canceled);
  expect(active).toBe(0);
});
