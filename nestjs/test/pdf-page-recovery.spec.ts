import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParsedPageCache, spoolPages } from "../src/modules/documents/parsers/parsed-page-cache";
import { paragraphBlocks } from "../src/modules/documents/parsers/parsed-document";
import { DocumentParser } from "../src/modules/documents/parsers/document.parser";
import PDFDocument from "pdfkit";

it("keeps processing beyond a failed first page, retries only that page, and replays cached pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-page-recovery-"));
  const cache = new ParsedPageCache(directory, async () => undefined);
  const calls: number[] = [];
  try {
    const work = async (n: number) => {
      calls.push(n);
      if (n === 1 && calls.filter((x) => x === 1).length === 1) throw new Error("fetch failed");
      if (n === 1) expect(calls).toContain(8);
      const text = `page ${n}`;
      return { document: { text, blocks: paragraphBlocks(text, n) }, regions: 0 };
    };
    const pages = [];
    for await (const page of spoolPages(8, 3, cache, work)) pages.push(page.document.text);
    expect(pages).toEqual(Array.from({ length: 8 }, (_, i) => `page ${i + 1}`));
    expect(calls).toHaveLength(9);
    for await (const _ of spoolPages(8, 3, cache, work)) {
      /* reuse */
    }
    expect(calls).toHaveLength(9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not publish a partial stream as successful when a page keeps failing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-page-failure-"));
  const cache = new ParsedPageCache(directory, async () => undefined);
  const visited: number[] = [];
  try {
    await expect(
      (async () => {
        for await (const _ of spoolPages(6, 2, cache, async (n) => {
          visited.push(n);
          if (n === 2) throw new Error("fetch failed");
          return { document: { text: `p${n}`, blocks: paragraphBlocks(`p${n}`, n) }, regions: 0 };
        })) {
        }
      })(),
    ).rejects.toThrow("fetch failed");
    expect(visited).toContain(6);
    expect(await cache.read(6)).toBeDefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("integrates durable page replay with ordered text, offsets and progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-parser-cache-"));
  const cache = new ParsedPageCache(directory, async () => undefined);
  const pdf = new PDFDocument();
  const buffers: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => {
    pdf.on("data", (b) => buffers.push(b));
    pdf.on("end", () => resolve(Buffer.concat(buffers)));
  });
  for (let i = 1; i <= 6; i++) {
    if (i > 1) pdf.addPage();
    pdf.text(`page ${i}`);
  }
  pdf.end();
  const input = await bytes;
  const calls: number[] = [];
  const visual = {
    enabled: true,
    concurrency: 3,
    parsedPages: async () => cache,
    page: async (_d: unknown, p: any, _t: string, context: any) => {
      calls.push(p.pageNumber);
      if (p.pageNumber === 1 && calls.filter((n) => n === 1).length === 1)
        throw new Error("fetch failed");
      await context.discovered(0);
      return { blocks: [] };
    },
  };
  const parser = new DocumentParser(visual as any);
  const scope = { userId: 1, documentId: 1, versionId: 1 };
  try {
    const first = await parser.parseStructured(input, "source.pdf", undefined, scope);
    expect(calls).toHaveLength(7);
    const second = await parser.parseStructured(input, "source.pdf", undefined, scope);
    expect(second).toEqual(first);
    expect(calls).toHaveLength(7);
    for (const block of second.blocks)
      expect(second.text.slice(block.location.start, block.location.end)).toBe(block.text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("invalidates a page when its cited image changes or disappears", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdf-cache-asset-"));
  const file = join(directory, "source.png");
  const cache = new ParsedPageCache(directory, async () => file);
  try {
    await writeFile(file, "original image");
    const blocks = paragraphBlocks("image", 1);
    blocks[0].location.pageImage = { page: 1, versionId: 1, profile: "a".repeat(64) };
    await cache.write(1, { document: { text: "image", blocks }, regions: 1 });
    expect(await cache.read(1)).toBeDefined();
    await writeFile(file, "corrupted image");
    expect(await cache.read(1)).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
