import PDFDocument from 'pdfkit';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';
import { PdfVisualService } from '../src/modules/documents/parsers/pdf-visual.service';
import { PageAssetsService } from '../src/modules/documents/page-assets.service';
import { MemoryStore } from '../src/persistence/memory.store';
import { RecursiveChunker } from '../src/modules/documents/chunkers/recursive.chunker';
import { TokenizerService } from '../src/modules/embeddings/tokenizer.service';
import { locateRegions } from '../src/modules/documents/parsers/pdf-layout';

async function fixture(
  kind:
    | 'text'
    | 'mixed'
    | 'vector'
    | 'scan'
    | 'watermark'
    | 'columns'
    | 'rotated'
    | 'narrow'
    | 'whitespace',
) {
  const doc = new PDFDocument({ size: [600, 800] });
  const parts: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => {
    doc.on('data', (b) => parts.push(b));
    doc.on('end', () => resolve(Buffer.concat(parts)));
  });
  if (kind !== 'scan' && kind !== 'columns') doc.text('Native explanation for diagram', 50, 60);
  if (kind === 'rotated') (doc.page as any).dictionary.data.Rotate = 90;
  if (kind === 'narrow' || kind === 'whitespace') {
    doc.rect(40, 140, 240, 100).stroke();
    doc.text('LEFT context', 40, 80);
    if (kind === 'narrow') doc.text('RIGHT secret', 310, 170);
    else {
      doc.text('LEFT caption', 40, 270);
      doc.text('RIGHT secret', 400, 270);
    }
  }
  if (kind === 'columns') {
    doc.text('LEFT context', 40, 60, { width: 180 });
    doc.text('RIGHT context', 350, 60, { width: 180 });
    doc.rect(50, 130, 180, 100).stroke();
    doc.rect(350, 130, 180, 100).stroke();
  }
  if (kind === 'watermark') {
    const image = createCanvas(300, 100);
    image.getContext('2d').fillText('watermark', 10, 40);
    for (let i = 0; i < 3; i++) {
      if (i) {
        doc.addPage();
        doc.text('Native explanation for diagram', 50, 60);
      }
      doc
        .save()
        .opacity(0.15)
        .image(image.toBuffer('image/png'), 100, 200, { width: 400 })
        .restore();
      doc.moveTo(20, 100).lineTo(580, 100).stroke();
    }
  }
  if (kind === 'mixed' || kind === 'scan') {
    if (kind === 'mixed') doc.text('page 142', 50, 100);
    const canvas = createCanvas(300, 160);
    canvas.getContext('2d').fillText('IMAGE42', 20, 50);
    doc.image(canvas.toBuffer('image/png'), kind === 'scan' ? 0 : 50, kind === 'scan' ? 0 : 140, {
      width: kind === 'scan' ? 600 : 300,
      height: kind === 'scan' ? 800 : 160,
    });
  }
  if (kind === 'vector' || kind === 'rotated') {
    doc.text('Figure caption', 60, 115);
    doc.rect(60, 160, 100, 60).stroke();
    doc.rect(260, 160, 100, 60).stroke();
    doc.moveTo(160, 190).lineTo(260, 190).stroke();
    doc.text('Review', 80, 180);
    doc.text('Publish', 280, 180);
  }
  doc.end();
  return bytes;
}

describe('content-aware PDF regions', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdf-regions-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  function setup(response = [{ type: 'figure', text: 'Review leads to Publish IMAGE42' }]) {
    const calls: { width: number; height: number; prompt: string }[] = [];
    const config = new ConfigService({ PAGE_ASSETS_DIR: dir, VISION_ENABLED: true });
    const llm: any = {
      complete: async (prompt: string, _: unknown, images: any[]) => {
        const image = await loadImage(Buffer.from(images[0].dataUrl.split(',')[1], 'base64'));
        calls.push({ width: image.width, height: image.height, prompt });
        return JSON.stringify({ blocks: response });
      },
    };
    const visual = new PdfVisualService(
      config,
      llm,
      new PageAssetsService(config, new MemoryStore()),
    );
    return { calls, parser: new DocumentParser(visual) };
  }
  const scope = { userId: 1, documentId: 1, versionId: 1 };
  it('never calls vision for a native text page', async () => {
    const p = setup();
    const parsed = await p.parser.parseStructured(await fixture('text'), 'a.pdf', undefined, scope);
    expect(parsed.text).toContain('Native explanation');
    expect(p.calls).toHaveLength(0);
  });
  it('does not pay vision tokens for repeated translucent watermarks and decorative rules', async () => {
    const p = setup();
    await p.parser.parseStructured(await fixture('watermark'), 'a.pdf', undefined, scope);
    expect(p.calls).toHaveLength(0);
  });
  it('keeps context and related native paragraphs within each column', async () => {
    const p = setup();
    const parsed = await p.parser.parseStructured(
      await fixture('columns'),
      'a.pdf',
      undefined,
      scope,
    );
    const figures = parsed.blocks.filter((b) => b.location.regionImage);
    expect(figures).toHaveLength(2);
    expect(figures[0].contextText).toContain('LEFT');
    expect(figures[0].contextText).not.toContain('RIGHT');
    const chunks = await new RecursiveChunker().splitTokenStructured(
      parsed,
      new TokenizerService(new ConfigService({ STORAGE_DRIVER: 'memory' })),
      { tokenizer: 'test:unicode-v1' } as any,
    );
    const left = chunks.find((c) => c.location.regionImage)!;
    const ranges = left.retrievalMetadata.contextRanges as { start: number; end: number }[];
    expect(ranges.map((r) => parsed.text.slice(r.start, r.end)).join('')).not.toContain('RIGHT');
  });
  it('locates graphics on rotated pages', async () => {
    const p = setup();
    const parsed = await p.parser.parseStructured(
      await fixture('rotated'),
      'a.pdf',
      undefined,
      scope,
    );
    expect(p.calls).toHaveLength(1);
    expect(parsed.blocks.some((b) => b.location.regionImage?.kind === 'region')).toBe(true);
    expect(p.calls[0].width).toBeLessThan(1000);
  });
  it.each(['narrow', 'whitespace'] as const)(
    'does not absorb other-column text through %s gaps',
    async (kind) => {
      const p = setup();
      const parsed = await p.parser.parseStructured(await fixture(kind), 'a.pdf', undefined, scope);
      const figure = parsed.blocks.find((b) => b.location.regionImage)!;
      expect(figure.location.regionImage!.bbox[2]).toBeLessThan(0.51);
      expect(figure.contextText).not.toContain('RIGHT');
    },
  );
  it.each(['mixed', 'vector'] as const)(
    'sends only local %s regions with nearby text and caches them',
    async (kind) => {
      const p = setup(),
        bytes = await fixture(kind);
      const parsed = await p.parser.parseStructured(bytes, 'a.pdf', undefined, scope);
      expect(p.calls.length).toBeGreaterThan(0);
      expect(p.calls.every((c) => c.height < 800 && c.width < 1000)).toBe(true);
      expect(p.calls[0].prompt).toContain('Native explanation');
      const block = parsed.blocks.find((b) => b.location.contentType === 'figure')!;
      expect((block.location as any).regionImage).toMatchObject({ page: 1, kind: 'region' });
      if (kind === 'vector') expect(block.location.regionImage!.bbox[1]).toBeLessThan(0.15);
      expect((block as any).contextText).toContain('Native explanation');
      const chunks = await new RecursiveChunker().splitTokenStructured(
        parsed,
        new TokenizerService(new ConfigService({ STORAGE_DRIVER: 'memory' })),
        { tokenizer: 'test:unicode-v1' } as any,
      );
      const figure = chunks.find((c) => c.location.regionImage)!;
      expect(figure.retrievalMetadata.embeddingText).toContain('Native explanation');
      expect(figure.retrievalMetadata.contextRanges).not.toEqual([]);
      for (const b of parsed.blocks)
        expect(parsed.text.slice(b.location.start, b.location.end)).toBe(b.text);
      const count = p.calls.length;
      expect(await p.parser.parseStructured(bytes, 'a.pdf', undefined, scope)).toEqual(parsed);
      expect(p.calls).toHaveLength(count);
    },
  );
  it('allows full-page OCR only for scans or explicit fallback', async () => {
    const p = setup();
    const parsed = await p.parser.parseStructured(await fixture('scan'), 'a.pdf', undefined, scope);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].height).toBe(1600);
    expect((parsed.blocks[0].location as any).regionImage.kind).toBe('scan');
  });
  it('records an explicit fallback when drawing bounds are unavailable', async () => {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const regions = await locateRegions(
      { numPages: 1, canvasFactory: { create: () => ({ canvas: {}, context: {} }), destroy() {} } },
      {
        getOperatorList: async () => ({
          fnArray: [OPS.paintImageXObject],
          argsArray: [['missing', 100, 100]],
        }),
        getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
        render: () => ({ promise: Promise.resolve() }),
      },
      'native',
      { items: [] },
    );
    expect(regions[0]).toMatchObject({
      kind: 'fallback',
      bbox: [0, 0, 1, 1],
      reason: '绘图边界不可用',
    });
  });
  it('keeps a numeric OCR value when the native text contains only a larger number', async () => {
    const p = setup([{ type: 'ocr', text: 'Order number\n42' }]);
    const parsed = await p.parser.parseStructured(
      await fixture('mixed'),
      'a.pdf',
      undefined,
      scope,
    );
    expect(parsed.text).toContain('Order number\n42');
  });
});
