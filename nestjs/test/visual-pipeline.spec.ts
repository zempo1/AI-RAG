import PDFDocument from 'pdfkit';
import { createCanvas } from '@napi-rs/canvas';
import { createServer, Server } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';
import { PdfVisualService } from '../src/modules/documents/parsers/pdf-visual.service';
import { PageAssetsService } from '../src/modules/documents/page-assets.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { IndexingService } from '../src/modules/documents/indexing.service';
import { RecursiveChunker } from '../src/modules/documents/chunkers/recursive.chunker';
import { pipeline } from './helpers/pipeline';
import { RagService } from '../src/modules/rag/rag.service';
import { TokenizerService } from '../src/modules/embeddings/tokenizer.service';

async function fixture(): Promise<Buffer> {
  const image = createCanvas(500, 100),
    ctx = image.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 500, 100);
  ctx.fillStyle = 'black';
  ctx.font = '30px sans-serif';
  ctx.fillText('IMAGE-ONLY-42', 10, 55);
  const doc = new PDFDocument();
  const buffers: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => {
    doc.on('data', (b) => buffers.push(b));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
  doc.text('Native source');
  doc.image(image.toBuffer('image/png'), 70, 130, { width: 400 });
  doc.rect(70, 350, 100, 60).stroke();
  doc.rect(270, 350, 100, 60).stroke();
  doc.moveTo(170, 380).lineTo(270, 380).stroke();
  doc.addPage();
  doc.image(image.toBuffer('image/png'), 70, 100, { width: 400 });
  doc.end();
  return bytes;
}

describe('rendered PDF vision pipeline with real HTTP and persistent page cache', () => {
  let server: Server,
    dir: string,
    base: string,
    failPage: number,
    failCall: number,
    calls: number[],
    badOutput: boolean;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      const content = body.messages[0].content;
      const label = content.find((b: any) => b.type === 'text' && /^第\d+页$/.test(b.text)).text;
      const page = Number(label.match(/\d+/)[0]);
      calls.push(page);
      const url = content.find((b: any) => b.type === 'image_url').image_url.url;
      const png = Buffer.from(url.split(',')[1], 'base64');
      if (png.subarray(1, 4).toString() !== 'PNG') {
        res.writeHead(400);
        res.end();
        return;
      }
      if (page === failPage || calls.length === failCall) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited' } }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: badOutput
                  ? 'invalid JSON'
                  : JSON.stringify({
                      blocks: [
                        { type: 'ocr', text: page === 1 ? 'Native source' : 'IMAGE-ONLY-42' },
                        { type: 'table', text: '| 指标 | 值 |\n| --- | --- |\n| 数量 | 42 |' },
                        { type: 'figure', text: '申请 → 审核，箭头由申请指向审核。' },
                      ],
                    }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'visual-pdf-'));
    calls = [];
    failPage = 0;
    failCall = 0;
    badOutput = false;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function parser(
    store: any,
    config = new ConfigService({
      PAGE_ASSETS_DIR: dir,
      VISION_API_KEY: 'test',
      VISION_BASE_URL: base,
      VISION_MODEL: 'qwen3.8-flash',
    }),
  ) {
    const assets = new PageAssetsService(config, store);
    return {
      assets,
      config,
      parser: new DocumentParser(new PdfVisualService(config, new LlmService(config), assets)),
    };
  }

  it('renders mixed and image-only pages, caches successes, and invalidates changed model profiles', async () => {
    const { MemoryStore } = await import('../src/persistence/memory.store');
    const store = new MemoryStore(),
      bytes = await fixture(),
      scope = { userId: 1, documentId: 1, versionId: 1 };
    const p = parser(store);
    const first = await p.parser.parseStructured(bytes, 'mixed.pdf', undefined, scope);
    expect(first.text.match(/Native source/g)).toHaveLength(1);
    expect(first.text).toContain('IMAGE-ONLY-42');
    expect(first.text).toContain('| 数量 | 42 |');
    expect(
      first.blocks.find((b) => b.location.contentType === 'figure')?.location.regionImage?.page,
    ).toBe(1);
    expect(first.blocks.find((b) => b.text.includes('IMAGE-ONLY'))?.location.page).toBe(2);
    const second = await p.parser.parseStructured(bytes, 'mixed.pdf', undefined, scope);
    expect(second).toEqual(first);
    expect(calls).toEqual([1, 1, 2]);
    p.config.set('VISION_MODEL', 'another-vision-model');
    const changed = await p.parser.parseStructured(bytes, 'mixed.pdf', undefined, scope);
    expect(
      changed.blocks.find((b) => b.location.regionImage)?.location.regionImage?.profile,
    ).not.toBe(first.blocks.find((b) => b.location.regionImage)?.location.regionImage?.profile);
    expect(calls).toEqual([1, 1, 2, 1, 1, 2]);
  });

  it('keeps the published index on page failure and reuses successful pages during retry', async () => {
    const p = await pipeline();
    try {
      const accepted = await p.documents.ingest(
        Buffer.from('# 原始版本\n\n已发布正文'),
        'old.md',
        1,
      );
      await p.indexing.process(accepted.taskId);
      const before = await p.store.get('documents', accepted.documentId);
      const replacement = await p.documents.ingest(await fixture(), 'mixed.pdf', 1, {
        documentId: accepted.documentId,
      });
      p.config.set('PAGE_ASSETS_DIR', dir);
      p.config.set('VISION_BASE_URL', base);
      p.config.set('VISION_API_KEY', 'test');
      const visual = parser(p.store, p.config);
      const indexing = new IndexingService(
        p.store,
        visual.parser,
        new RecursiveChunker(),
        p.embeddings as any,
        p.vectors,
        p.tasks,
        p.config,
        visual.assets,
      );
      failPage = 2;
      await expect(indexing.process(replacement.taskId)).rejects.toThrow('第2页');
      expect((await p.store.get('tasks', replacement.taskId))?.status).toBe('retrying');
      expect((await p.store.get('documents', accepted.documentId))?.activeIndexRevisionId).toBe(
        before?.activeIndexRevisionId,
      );
      failPage = 0;
      await indexing.process(replacement.taskId, 2);
      expect(calls).toEqual([1, 1, 2, 2]);
      const ready = await p.store.get('documents', accepted.documentId);
      expect(ready?.activeIndexRevisionId).not.toBe(before?.activeIndexRevisionId);
      expect(ready?.content).toContain('IMAGE-ONLY-42');
      const chunks = await p.store.list('chunks', {
        indexRevisionId: ready?.activeIndexRevisionId,
      });
      expect(
        chunks.some((c) => c.location?.contentType === 'table' && c.location.regionImage),
      ).toBe(true);
      const context = await new RagService(
        p.embeddings as any,
        p.vectors,
        p.store,
        p.libraries,
        new TokenizerService(p.config),
        undefined,
        p.config,
      ).prepare('申请审核的流程', 1, accepted.knowledgeBaseId, {
        documentIds: [accepted.documentId],
        mode: 'search',
      });
      expect(
        context.sources.some((s) => s.location?.contentType === 'figure' && s.location.regionImage),
      ).toBe(true);
      expect(context.sources.some((s) => s.location?.contentType === 'native')).toBe(true);
    } finally {
      await p.cleanup();
    }
  });

  it('rejects malformed provider output rather than publishing a text-only success', async () => {
    badOutput = true;
    const { MemoryStore } = await import('../src/persistence/memory.store');
    await expect(
      parser(new MemoryStore()).parser.parseStructured(await fixture(), 'bad.pdf', undefined, {
        userId: 1,
        documentId: 1,
        versionId: 1,
      }),
    ).rejects.toThrow('第1页');
  });
  it('retries only the failed region while preserving successful regions on the same page', async () => {
    const { MemoryStore } = await import('../src/persistence/memory.store');
    const p = parser(new MemoryStore()),
      bytes = await fixture();
    const scope = { userId: 1, documentId: 1, versionId: 1 };
    failCall = 2;
    await expect(p.parser.parseStructured(bytes, 'a.pdf', undefined, scope)).rejects.toThrow(
      '图片区域2',
    );
    failCall = 0;
    await p.parser.parseStructured(bytes, 'a.pdf', undefined, scope);
    expect(calls).toEqual([1, 1, 1, 2]);
  });

  it('rebuilds a truncated PNG cache while reusing intact pages', async () => {
    const { MemoryStore } = await import('../src/persistence/memory.store');
    const p = parser(new MemoryStore()),
      bytes = await fixture();
    const scope = { userId: 1, documentId: 1, versionId: 1 };
    const first = await p.parser.parseStructured(bytes, 'mixed.pdf', undefined, scope);
    const ref = first.blocks.find((b) => b.location.regionImage)!.location.regionImage!;
    const file = join(p.assets.directory(scope, ref.profile), `1-${ref.regionId}.png`);
    const original = await readFile(file);
    await writeFile(file, original.subarray(0, 30));
    const repaired = await p.parser.parseStructured(bytes, 'mixed.pdf', undefined, scope);
    expect(repaired).toEqual(first);
    expect((await readFile(file)).equals(original)).toBe(true);
    expect(calls).toEqual([1, 1, 2, 1]);
  });

  it('checks cancellation before each paid request and preserves the cancellation error type', async () => {
    const { MemoryStore } = await import('../src/persistence/memory.store');
    class Canceled extends Error {}
    await expect(
      parser(new MemoryStore()).parser.parseStructured(await fixture(), 'cancel.pdf', undefined, {
        userId: 1,
        documentId: 1,
        versionId: 1,
        guard: async () => {
          throw new Canceled('canceled');
        },
      }),
    ).rejects.toBeInstanceOf(Canceled);
    expect(calls).toEqual([]);
  });

  it('asks to reupload a legacy PDF without its original instead of claiming visual coverage', async () => {
    const p = await pipeline();
    try {
      const library = await p.libraries.resolve(1);
      const document = await p.store.save('documents', {
        userId: 1,
        knowledgeBaseId: library.id,
        filename: 'legacy.pdf',
        content: '历史纯文字',
        status: 'ready',
        deletedAt: null,
      });
      const accepted = await p.documents.reindex(document.id, 1);
      await expect(p.indexing.process(accepted.taskId)).rejects.toThrow('重新上传');
    } finally {
      await p.cleanup();
    }
  });
});
