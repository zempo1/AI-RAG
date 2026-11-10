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
import { groupNearbyCrops, locateRegions, PdfRegion } from '../src/modules/documents/parsers/pdf-layout';
import { pdfRegionScale } from '../src/modules/documents/parsers/pdf-render-cache';

async function fixture(
  kind:
    | 'text'
    | 'mixed'
    | 'vector'
    | 'scan'
    | 'watermark'
    | 'pixel-watermark'
    | 'columns'
    | 'rotated'
    | 'narrow'
    | 'sidebar'
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
  if (kind === 'sidebar') {
    doc.rect(40, 150, 135, 100).stroke();
    doc.rect(43, 322, 135, 100).stroke();
    doc.rect(355, 150, 135, 100).stroke();
  }
  if (kind === 'watermark' || kind === 'pixel-watermark') {
    const image = createCanvas(300, 100);
    const ctx = image.getContext('2d');
    if (kind === 'pixel-watermark') ctx.globalAlpha = 0.17;
    ctx.fillText('watermark', 10, 40);
    for (let i = 0; i < 3; i++) {
      if (i) {
        doc.addPage();
        doc.text('Native explanation for diagram', 50, 60);
      }
      doc
        .save()
        .opacity(kind === 'watermark' ? 0.15 : 1)
        .image(image.toBuffer('image/png'), 100 + (kind === 'pixel-watermark' ? i * 5 : 0), 200, { width: 400 })
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
  function setup(
    response: unknown = [{ type: 'figure', text: 'Review leads to Publish IMAGE42' }],
  ) {
    const calls: { width: number; height: number; prompt: string }[] = [];
    const config = new ConfigService({ PAGE_ASSETS_DIR: dir, VISION_ENABLED: true });
    const llm: any = {
      complete: async (prompt: string, _: unknown, images: any[]) => {
        const image = await loadImage(Buffer.from(images[0].dataUrl.split(',')[1], 'base64'));
        calls.push({ width: image.width, height: image.height, prompt });
        return JSON.stringify({ blocks: typeof response === 'function' ? response() : response });
      },
    };
    const visual = new PdfVisualService(
      config,
      llm,
      new PageAssetsService(config, new MemoryStore()),
    );
    (visual as any).analysis = {
      health: async () => ({ ready: true, manifest: 'fixture-models' }),
      cacheDirectory: () => undefined,
      layout: async () => ({
        manifest: 'fixture-models',
        regions: [{ kind: 'text', bbox: [0.02, 0.02, 0.98, 0.98], score: 0.99 }],
      }),
      ocr: async (_bytes: Buffer, _signal?: AbortSignal, classify?: boolean) => ({
        manifest: 'fixture-models',
        ...(classify
          ? { textOnly: false, blocks: [] }
          : { blocks: [{ text: 'IMAGE42', bbox: [0, 0, 1, 1], score: 0.99 }] }),
      }),
    };
    return { calls, parser: new DocumentParser(visual) };
  }
  const scope = { userId: 1, documentId: 1, versionId: 1 };
  it('shares one vision request for nearby regions in a narrow column and keeps the other column separate', async () => {
    const p = setup();
    const parsed = await p.parser.parseStructured(await fixture('sidebar'), 'a.pdf', undefined, scope);
    const boxes = parsed.blocks.flatMap((block) =>
      block.location.regionImage ? [block.location.regionImage.bbox] : [],
    );
    expect(p.calls).toHaveLength(2);
    expect(boxes).toHaveLength(2);
    expect(boxes.find((box) => box[0] < 0.1)?.[3]).toBeGreaterThan(0.5);
    expect(boxes.some((box) => box[0] > 0.5)).toBe(true);
  });
  it('keeps separate crops when grouping would reduce either image resolution', () => {
    const regions: PdfRegion[] = [
      { kind: 'region', bbox: [0.1, 0.2, 0.3, 0.42], textIndexes: [], context: '' },
      { kind: 'region', bbox: [0.1, 0.46, 0.3, 0.68], textIndexes: [], context: '' },
    ];
    const grouped = groupNearbyCrops(regions, ([x0, y0, x1, y1], limit) =>
      pdfRegionScale(1200 * (x1 - x0), 10000 * (y1 - y0), limit),
    );
    expect(grouped).toEqual(regions);
  });
  it('fills the vision slots from multiple regions on a single legacy PDF page', async () => {
    const config = new ConfigService({ PAGE_ASSETS_DIR: dir, VISION_CONCURRENCY: 3 });
    let active = 0;
    let peak = 0;
    let calls = 0;
    const visual = new PdfVisualService(
      config,
      {
        complete: async () => {
          calls++;
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 50));
          active--;
          return JSON.stringify({ blocks: [{ type: 'figure', text: 'diagram' }] });
        },
      } as any,
      new PageAssetsService(config, new MemoryStore()),
    );
    const parser = new DocumentParser(visual);
    const bytes = await fixture('columns');
    const parsed = await parser.parseStructured(bytes, 'a.pdf', undefined, scope);
    const boxes = parsed.blocks.flatMap((block) => block.location.regionImage?.bbox[0] ?? []);
    expect(peak).toBe(2);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeLessThan(boxes[1]);
    expect(await parser.parseStructured(bytes, 'a.pdf', undefined, scope)).toEqual(parsed);
    expect(calls).toBe(2);
  });
  it('repairs a malformed region once and caches only the valid result', async () => {
    let attempt = 0;
    const p = setup(() =>
      ++attempt === 1 ? [{ type: 'unknown', text: 'bad' }] : [{ type: 'figure', text: 'A → B' }],
    );
    const bytes = await fixture('mixed');
    const parsed = await p.parser.parseStructured(bytes, 'a.pdf', undefined, scope);
    expect(p.calls).toHaveLength(2);
    expect(parsed.text).toContain('A → B');
    expect(p.calls[1].prompt).toContain('上次输出格式校验失败');
    expect(await p.parser.parseStructured(bytes, 'a.pdf', undefined, scope)).toEqual(parsed);
    expect(p.calls).toHaveLength(2);
  });
  it('fails clearly after one unsuccessful format repair', async () => {
    const p = setup([{ type: 'unknown', text: 'bad' }]);
    await expect(
      p.parser.parseStructured(await fixture('mixed'), 'a.pdf', undefined, scope),
    ).rejects.toThrow('blocks[0].type');
    expect(p.calls).toHaveLength(2);
  });
  it('retries a timed-out visual region in place and caches the successful result', async () => {
    let calls = 0;
    const p = setup(() => {
      if (++calls === 1) throw new Error('Request timed out.');
      return [{ type: 'figure', text: 'A → B' }];
    });
    const bytes = await fixture('mixed');
    const result = await p.parser.parseStructured(bytes, 'a.pdf', undefined, scope);
    expect(result.text).toContain('A → B');
    expect(await p.parser.parseStructured(bytes, 'a.pdf', undefined, scope)).toEqual(result);
    expect(calls).toBe(2);
  });
  it('accepts a single validated visual block even if the model omitted the array wrapper', async () => {
    const p = setup({ type: 'figure', text: 'A → B' });
    const result = await p.parser.parseStructured(await fixture('mixed'), 'a.pdf', undefined, scope);
    expect(result.text).toContain('A → B');
    expect(p.calls).toHaveLength(1);
  });
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
  it('skips repeated watermarks with translucency encoded in the bitmap even when shifted', async () => {
    const p = setup();
    const result = await p.parser.parseStructured(await fixture('pixel-watermark'), 'a.pdf', undefined, scope);
    expect(result.blocks.every((b) => b.location.contentType === 'native')).toBe(true);
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
  it('uses local OCR for a scanned text page', async () => {
    const p = setup();
    const parsed = await p.parser.parseStructured(await fixture('scan'), 'a.pdf', undefined, scope);
    expect(p.calls).toHaveLength(0);
    expect(parsed.blocks[0]).toMatchObject({ text: '[图片文字识别]\nIMAGE42',
      location: { contentType: 'ocr', regionImage: { page: 1 } } });
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
