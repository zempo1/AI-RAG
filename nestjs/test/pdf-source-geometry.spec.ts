import PDFDocument from 'pdfkit';
import { ConfigService } from '@nestjs/config';
import { createCanvas } from '@napi-rs/canvas';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';
import { PdfVisualService } from '../src/modules/documents/parsers/pdf-visual.service';
import { textPositions } from '../src/modules/documents/parsers/pdf-layout';
import { PageAssetsService } from '../src/modules/documents/page-assets.service';
import { MemoryStore } from '../src/persistence/memory.store';

const scope = { userId: 1, documentId: 1, versionId: 1 };
const profile = 'b'.repeat(64);

async function nativePdf() {
  const pdf = new PDFDocument({ size: [600, 800], margin: 40 });
  const pieces: Buffer[] = [];
  const result = new Promise<Buffer>((resolve) => {
    pdf.on('data', (piece) => pieces.push(piece));
    pdf.on('end', () => resolve(Buffer.concat(pieces)));
  });
  pdf.text('Repeated source', 50, 60);
  pdf.text('Repeated source', 50, 180);
  pdf.addPage();
  pdf.text('Next page source', 50, 80);
  pdf.end();
  return result;
}

/** Identity-V with explicit vertical metrics and Unicode mapping; no installed font is needed. */
function verticalPdf() {
  const unicode = `/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0001> <4E2D> <0002> <6587> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`;
  const stream = 'BT /F1 20 Tf 1 0 0 1 200 500 Tm <00010002> Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /Identity-V /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /DW2 [880 -1000] >>',
    `<< /Length ${Buffer.byteLength(unicode)} >>\nstream\n${unicode}\nendstream`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 6 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 800 /StemV 80 >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

describe('PDF source geometry', () => {
  it('keeps repeated native item ranges distinct across paragraphs and global page offsets', async () => {
    const bytes = await nativePdf();
    const parser = new DocumentParser();
    const pages: any[] = [];
    for await (const page of parser.parsePages(bytes)) pages.push(page);
    const full: any = await parser.parseStructured(bytes, 'source.pdf');
    expect(full.text).toBe('Repeated source\n\nRepeated source\nNext page source');
    expect(full.blocks).toHaveLength(3);
    for (const block of full.blocks) {
      expect(block.location.anchorVersion).toBe(1);
      expect(block.location.anchors).toHaveLength(1);
      const anchor = block.location.anchors[0];
      expect(full.text.slice(anchor.start, anchor.end)).toBe(block.text);
      expect(anchor).toMatchObject({ page: block.location.page, kind: 'native' });
      expect(anchor.rects).toHaveLength(1);
      expect(anchor.rects[0][0]).toBeCloseTo(50 / 600, 3);
      expect(anchor.rects[0].every((n: number) => n >= 0 && n <= 1)).toBe(true);
    }
    expect(full.blocks[0].location.anchors[0].rects[0][1]).toBeLessThan(0.1);
    expect(full.blocks[1].location.anchors[0].rects[0][1]).toBeGreaterThan(0.2);
    let offset = 0;
    for (const page of pages) {
      const global = full.blocks.filter(
        (b: any) => b.location.page === page.blocks[0].location.page,
      );
      expect(global.map((b: any) => b.location.anchors)).toEqual(
        page.blocks.map((b: any) =>
          b.location.anchors.map((a: any) => ({
            ...a,
            start: a.start + offset,
            end: a.end + offset,
          })),
        ),
      );
      offset += page.text.length + 1;
    }
  });

  it.each([true, false])(
    'moves native anchors after an inserted figure and leaves labels without geometry (sourceBox=%s)',
    async (hasSourceBox) => {
      const visual = {
        enabled: true,
        concurrency: 1,
        page: async (_document: any, page: any) => ({
          blocks:
            page.pageNumber === 1
              ? [
                  {
                    type: 'figure',
                    text: 'Diagram relation',
                    ...(hasSourceBox
                      ? { sourceBox: [0.1, 0.15, 0.4, 0.2], anchorKind: 'region' }
                      : {}),
                    regionImage: {
                      ...scope,
                      page: 1,
                      profile,
                      regionId: 'region',
                      kind: 'region',
                      bbox: [0.1, 0.15, 0.4, 0.2],
                    },
                  },
                ]
              : [],
        }),
      };
      const parsed: any = await new DocumentParser(visual as any).parseStructured(
        await nativePdf(),
        'source.pdf',
        undefined,
        scope,
      );
      expect(parsed.blocks.map((b: any) => b.text)).toEqual([
        'Repeated source',
        '[模型生成的图解]\nDiagram relation',
        'Repeated source',
        'Next page source',
      ]);
      const figure = parsed.blocks[1];
      expect(figure.location.anchors).toEqual([
        {
          page: 1,
          start: figure.location.start + '[模型生成的图解]\n'.length,
          end: figure.location.end,
          rects: [[0.1, 0.15, 0.4, 0.2]],
          kind: 'region',
        },
      ]);
      for (const block of parsed.blocks.filter((b: any) => b.location.contentType === 'native'))
        expect(
          parsed.text.slice(block.location.anchors[0].start, block.location.anchors[0].end),
        ).toBe(block.text);
    },
  );

  it('retains item boxes for both columns without filling the gap between them', async () => {
    const pdf = new PDFDocument({ size: [600, 800] });
    const pieces: Buffer[] = [];
    const bytes = new Promise<Buffer>((resolve) => {
      pdf.on('data', (part) => pieces.push(part));
      pdf.on('end', () => resolve(Buffer.concat(pieces)));
    });
    pdf.text('First native line', 50, 60);
    pdf.text('Second native line', 50, 74);
    pdf.text('Right first line', 350, 60);
    pdf.text('Right second line', 350, 74);
    pdf.end();
    const parsed: any = await new DocumentParser().parseStructured(await bytes, 'lines.pdf');
    expect(parsed.blocks).toHaveLength(1);
    const anchors = parsed.blocks[0].location.anchors;
    expect(anchors).toHaveLength(4);
    expect(anchors.map((a: any) => parsed.text.slice(a.start, a.end))).toEqual([
      'First native line',
      'Second native line',
      'Right first line',
      'Right second line',
    ]);
    expect(anchors.slice(0, 2).every((a: any) => a.rects[0][2] < 0.4)).toBe(true);
    expect(anchors.slice(2).every((a: any) => a.rects[0][0] > 0.5)).toBe(true);
  });

  it('normalizes a real rotated PDF against its visible CropBox', async () => {
    const pdf = new PDFDocument({ size: [600, 800] });
    const pieces: Buffer[] = [];
    const bytes = new Promise<Buffer>((resolve) => {
      pdf.on('data', (part) => pieces.push(part));
      pdf.on('end', () => resolve(Buffer.concat(pieces)));
    });
    (pdf.page as any).dictionary.data.Rotate = 90;
    (pdf.page as any).dictionary.data.CropBox = [20, 100, 580, 700];
    pdf.text('Rotated crop', 80, 180);
    pdf.end();
    const parsed: any = await new DocumentParser().parseStructured(await bytes, 'rotated.pdf');
    const anchor = parsed.blocks[0].location.anchors[0];
    expect(parsed.text.slice(anchor.start, anchor.end)).toBe('Rotated crop');
    const [left, top, right, bottom] = anchor.rects[0];
    // PDF (80, 620) is viewport (520, 60) after CropBox translation and 90° rotation.
    expect(left).toBeGreaterThan(0.84);
    expect(right).toBeCloseTo(520 / 600, 3);
    expect(top).toBeCloseTo(60 / 560, 3);
    expect(bottom).toBeGreaterThan(top + 0.1);
    expect(bottom).toBeLessThan(top + 0.2);
  });

  it('uses font ascent and descent only in explicit accurate geometry mode', () => {
    const content = {
      items: [
        { str: 'glyphs', width: 40, height: 10, fontName: 'f', transform: [10, 0, 0, 10, 50, 100] },
      ],
      styles: { f: { ascent: 0.8, descent: -0.2 } },
    };
    const position = textPositions(
      content,
      { width: 160, height: 200, transform: [0, 1, 1, 0, -20, -10] },
      { fontMetrics: true },
    )[0];
    expect(position.bbox).toEqual([0.4875, 0.2, 0.55, 0.4]);
  });

  it('preserves full-em text boxes used by native coverage routing by default', () => {
    const content = {
      items: [
        { str: 'glyphs', width: 40, height: 10, fontName: 'f', transform: [10, 0, 0, 10, 50, 100] },
      ],
      styles: { f: { ascent: 0.8, descent: -0.2 } },
    };
    const position = textPositions(content, {
      width: 160,
      height: 200,
      transform: [0, 1, 1, 0, -20, -10],
    })[0];
    expect(position.bbox).toEqual([0.5, 0.2, 0.5625, 0.4]);
  });

  it.each([
    {
      name: 'unrotated page',
      viewport: { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] },
      expected: [0.32666666666666666, 0.375, 0.36, 0.425],
    },
    {
      name: 'intrinsically rotated crop viewport',
      viewport: { width: 600, height: 560, transform: [0, 1, 1, 0, -100, -20] },
      expected: [0.6, 0.3142857142857143, 0.6666666666666666, 0.35],
    },
  ])(
    'uses vertical run length and transform font size in an accurate $name',
    ({ viewport, expected }) => {
      const content = {
        items: [
          {
            str: '中文',
            dir: 'ttb',
            width: 20,
            height: 40,
            fontName: 'v',
            transform: [20, 0, 0, 20, 200, 500],
          },
        ],
        styles: { v: { vertical: true, ascent: 0.8, descent: -0.2 } },
      };
      const [position] = textPositions(content, viewport, { fontMetrics: true });
      expected.forEach((value, index) => expect(position.bbox[index]).toBeCloseTo(value, 12));
    },
  );

  it('keeps the legacy full-em layout box for vertical fonts by default', () => {
    const content = {
      items: [
        {
          str: '中文',
          dir: 'ttb',
          width: 20,
          height: 40,
          fontName: 'v',
          transform: [20, 0, 0, 20, 200, 500],
        },
      ],
      styles: { v: { vertical: true, ascent: 0.8, descent: -0.2 } },
    };
    const [position] = textPositions(content, {
      width: 600,
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    });
    expect(position.bbox).toEqual([1 / 3, 0.325, 11 / 30, 0.375]);
  });

  it('anchors a real Identity-V PDF vertical run down the page without guessing character widths', async () => {
    const parsed: any = await new DocumentParser().parseStructured(verticalPdf(), 'vertical.pdf');
    expect(parsed.text).toBe('中文');
    expect(parsed.blocks[0].location.anchors).toHaveLength(1);
    const anchor = parsed.blocks[0].location.anchors[0];
    expect(anchor).toMatchObject({ page: 1, start: 0, end: 2, kind: 'native' });
    [0.32666666666666666, 0.375, 0.36, 0.425].forEach((value, index) =>
      expect(anchor.rects[0][index]).toBeCloseTo(value, 12),
    );
  });
});

describe('PDF recognition source geometry and cache', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdf-source-geometry-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  function setup(
    ocr: () => Promise<any>,
    complete = async () =>
      JSON.stringify({ blocks: [{ type: 'figure', text: 'fallback diagram' }] }),
  ) {
    const config = new ConfigService({ PAGE_ASSETS_DIR: dir });
    const assets = new PageAssetsService(config, new MemoryStore());
    const visual: any = new PdfVisualService(config, { complete } as any, assets);
    visual.analysis = { ocr, health: async () => ({ ready: true, manifest: 'ocr-v1' }) };
    const document = {
      numPages: 1,
      canvasFactory: {
        create(w: number, h: number) {
          const canvas = createCanvas(w, h);
          return { canvas, context: canvas.getContext('2d') };
        },
        destroy() {},
      },
    };
    const page = {
      pageNumber: 1,
      getViewport: ({ scale }: any) => ({ width: 200 * scale, height: 200 * scale }),
      render: () => ({ promise: Promise.resolve() }),
    };
    return {
      visual,
      assets,
      page,
      run: (region: any) => visual.region(document, page, '', scope, profile, region, 1),
    };
  }
  const region = {
    bbox: [0.2, 0.3, 0.8, 0.7],
    kind: 'region',
    context: '',
    textIndexes: [],
    recognition: 'ocr',
    analysisProfile: 'ocr-v1',
  };

  it('maps reliable OCR line coordinates from crop space into page coordinates', async () => {
    const f = setup(async () => ({
      manifest: 'ocr-v1',
      blocks: [{ text: 'line', bbox: [0.1, 0.2, 0.5, 0.4], score: 0.99 }],
    }));
    const [block] = await f.run(region);
    expect(block.anchorKind).toBe('ocr');
    expect(block.sourceBox).toHaveLength(4);
    [0.26, 0.38, 0.5, 0.46].forEach((value, n) =>
      expect(block.sourceBox[n]).toBeCloseTo(value, 12),
    );
  });

  it('uses the actual uncovered crop for a local vision fallback', async () => {
    const f = setup(async () => ({
      manifest: 'ocr-v1',
      blocks: [{ text: 'left', bbox: [0, 0, 0.4, 1], score: 0.99 }],
    }));
    const blocks = await f.run({
      ...region,
      bbox: [0, 0, 1, 1],
      ocrExpectedBoxes: [
        [0, 0, 0.4, 1],
        [0.6, 0, 1, 1],
      ],
    });
    expect(
      blocks.map((b: any) => ({ text: b.text, box: b.sourceBox, kind: b.anchorKind })),
    ).toEqual([
      { text: 'left', box: [0, 0, 0.4, 1], kind: 'ocr' },
      { text: 'fallback diagram', box: [0.6, 0, 1, 1], kind: 'region' },
    ]);
  });

  it.each([
    ['ocr', 'legacy'],
    ['vision', 'legacy'],
    ['ocr', 'invalid'],
    ['vision', 'invalid'],
  ])(
    'round-trips %s geometry and rebuilds a %s region cache with recognition reuse',
    async (recognition, corruption) => {
      let ocrCalls = 0,
        visionCalls = 0;
      const f = setup(
        async () => {
          ocrCalls++;
          return {
            manifest: 'ocr-v1',
            blocks: [{ text: 'line', bbox: [0.1, 0.2, 0.5, 0.4], score: 0.99 }],
          };
        },
        async () => {
          visionCalls++;
          return JSON.stringify({ blocks: [{ type: 'table', text: '|cell|' }] });
        },
      );
      const target = { ...region, recognition };
      const first = await f.run(target);
      expect(first[0].sourceBox).toBeDefined();
      expect(await f.run(target)).toEqual(first);
      const path = f.assets.directory(scope, profile);
      const cachePath = join(
        path,
        (await readdir(path)).find((name) => name.endsWith('.json'))!,
      );
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      expect(cached.geometryVersion).toBe(1);
      if (corruption === 'legacy') {
        delete cached.geometryVersion;
        cached.blocks.forEach((b: any) => {
          delete b.sourceBox;
          delete b.anchorKind;
        });
      } else cached.blocks[0].sourceBox = [0, 0, -1, 2];
      await writeFile(cachePath, JSON.stringify(cached));
      expect(await f.run(target)).toEqual(first);
      expect(ocrCalls).toBe(recognition === 'ocr' ? 1 : 0);
      expect(visionCalls).toBe(recognition === 'vision' ? 1 : 0);
      expect(JSON.parse(await readFile(cachePath, 'utf8')).geometryVersion).toBe(1);
    },
  );
});
