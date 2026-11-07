import PDFDocument from 'pdfkit';
import { createCanvas } from '@napi-rs/canvas';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateHybridRegions } from '../src/modules/documents/parsers/hybrid-layout';
import {
  PdfAnalysisClient,
  LayoutRegion,
} from '../src/modules/documents/parsers/pdf-analysis.client';

async function fixture(
  kind:
    | 'text'
    | 'clipped-text'
    | 'ruled-text'
    | 'prose-fragments'
    | 'short-native'
    | 'table'
    | 'table-short'
    | 'vector'
    | 'vector-image'
    | 'image-native-prose'
    | 'image-native-inside'
    | 'image-native-overlay'
    | 'image-large'
    | 'vector-sparse'
    | 'vector-empty'
    | 'vector-large'
    | 'grid-table'
    | 'scan'
    | 'scan-native'
    | 'scan-sparse'
    | 'framed-vector'
    | 'glyph'
    | 'blank',
) {
  const pdf = new PDFDocument({ size: [600, 800], margin: 0 });
  const parts: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => {
    pdf.on('data', (b) => parts.push(b));
    pdf.on('end', () => resolve(Buffer.concat(parts)));
  });
  if (kind === 'prose-fragments') {
    const fragment = 'A continuous paragraph ';
    const nextX = 50 + pdf.widthOfString(fragment);
    pdf.text('1.2', 50, 60);
    pdf.text('Chapter title', nextX, 60);
    for (const y of [100, 135]) {
      pdf.text(fragment, 50, y);
      pdf.font('Helvetica-Bold').text('continues on the same line', nextX, y).font('Helvetica');
    }
  } else if (kind === 'clipped-text') {
    pdf.save().rect(0, 0, 600, 800).clip();
    pdf.text('Native explanation for diagram', 40, 60);
    pdf.restore();
  } else if (kind === 'short-native') {
    pdf.text('6 OK', 60, 100);
    pdf.save().rect(0, 0, 600, 800).clip();
    pdf.text('Another paragraph', 60, 160);
    pdf.restore();
  } else if (kind === 'table' || kind === 'table-short' || kind === 'grid-table') {
    for (let row = 0; row < (kind === 'table-short' ? 2 : 4); row++) {
      pdf.text('Item ' + row, 50, 100 + row * 35);
      pdf.text(String(row + 10), 200, 100 + row * 35);
      pdf.text(String(row + 100), 350, 100 + row * 35);
    }
  } else if (kind !== 'scan' && kind !== 'blank' && kind !== 'vector-empty')
    pdf.text('Native explanation for diagram', 40, 60);
  if (
    kind === 'vector' ||
    kind === 'vector-image' ||
    kind === 'vector-sparse' ||
    kind === 'vector-empty'
  ) {
    pdf.rect(50, 150, 100, 60).stroke();
    pdf.rect(230, 150, 100, 60).stroke();
    pdf.moveTo(150, 180).lineTo(230, 180).stroke();
    if (kind === 'vector' || kind === 'vector-image') {
      pdf.text('Node A', 60, 170);
      pdf.text('Node B', 240, 170);
      pdf.text('Figure caption', 55, 230);
      pdf.text('RIGHT secret', 390, 230);
    }
  }
  if (kind === 'vector-image') {
    const c = createCanvas(100, 50);
    c.getContext('2d').fillText('Raster labels', 5, 25);
    pdf.image(c.toBuffer('image/png'), 50, 400, { width: 100, height: 50 });
  }
  if (kind.startsWith('image-')) {
    const inside = kind === 'image-native-inside' || kind === 'image-native-overlay';
    pdf.text(
      inside && kind !== 'image-native-overlay' ? 'Note' : 'A second reliable native paragraph',
      40,
      100,
    );
    if (inside) {
      for (let row = 0; row < 8; row++)
        pdf.text('Recovered OCR layer text inside the embedded page image', 60, 170 + row * 35);
    }
    const c = createCanvas(400, 400);
    c.getContext('2d').fillText('Embedded graphic', 20, 30);
    pdf.image(c.toBuffer('image/png'), 50, 150, {
      width: kind === 'image-large' ? 500 : 400,
      height: kind === 'image-large' ? 500 : 400,
    });
  }
  if (kind === 'vector-large') {
    pdf.text('Second readable paragraph', 40, 100);
    pdf.rect(20, 120, 560, 650).stroke();
  }
  if (kind === 'grid-table') {
    for (let row = 0; row <= 4; row++)
      pdf
        .moveTo(45, 95 + row * 35)
        .lineTo(450, 95 + row * 35)
        .stroke();
    for (const x of [45, 190, 340, 450]) pdf.moveTo(x, 95).lineTo(x, 235).stroke();
  }
  if (kind === 'framed-vector') {
    pdf.rect(60, 120, 480, 520).stroke();
    pdf.rect(80, 200, 100, 60).stroke();
  }
  if (kind === 'scan-sparse') {
    pdf.text('Recovered scanned paragraph first line with native text', 60, 100);
    pdf.text('Recovered scanned paragraph final line with native text', 60, 620);
  }
  if (kind === 'glyph') pdf.rect(41, 60, 170, 15).stroke();
  if (kind === 'ruled-text') pdf.moveTo(30, 90).lineTo(570, 90).stroke();
  if (
    kind === 'scan' ||
    kind === 'scan-native' ||
    kind === 'scan-sparse' ||
    kind === 'short-native'
  ) {
    const c = createCanvas(600, 800);
    c.getContext('2d').fillText('Scanned text', 50, 60);
    pdf.image(c.toBuffer('image/png'), 0, 0, { width: 600, height: 800 });
  }
  pdf.end();
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(await bytes),
    useSystemFonts: true,
    verbosity: 0,
  });
  const document = await task.promise;
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const native = content.items.map((i: any) => i.str || '').join('\n');
  return { task, document, page, content, native };
}

describe('hybrid PDF layout', () => {
  let dir: string;
  let manifest: string;
  let regions: LayoutRegion[];
  let calls: string[];
  const scope = { userId: 1, documentId: 2, versionId: 3 };
  let client: PdfAnalysisClient;
  let config: ConfigService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hybrid-layout-'));
    manifest = 'layout-a';
    calls = [];
    regions = [];
    config = new ConfigService({ PAGE_ASSETS_DIR: dir, PDF_ANALYSIS_NATIVE_FAST_PATH: false });
    client = new PdfAnalysisClient(config);
    // The external model boundary is the only fake: PDF parsing, drawing, geometry and disk cache run normally.
    client.health = async () => {
      calls.push('health');
      return { ready: true, manifest };
    };
    client.layout = async (_bytes, precision) => {
      calls.push(precision);
      return { regions, manifest };
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  async function run(kind: Parameters<typeof fixture>[0], changedScope = scope) {
    const f = await fixture(kind);
    try {
      return await locateHybridRegions(
        f.document,
        f.page,
        f.native,
        f.content,
        changedScope,
        client,
      );
    } finally {
      await f.task.destroy();
    }
  }
  it('makes no service request for reliable native prose without graphics', async () => {
    expect(await run('text')).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('does not confuse contiguous prose fragments aligned with a spaced title for table columns', async () => {
    expect(await run('prose-fragments')).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('uses the default native vector fast path without model health or layout requests', async () => {
    config.set('PDF_ANALYSIS_NATIVE_FAST_PATH', undefined);
    const found = await run('vector');
    expect(calls).toEqual([]);
    expect(found).toHaveLength(1);
    expect(found[0].recognition).toBe('vision');
    expect(found[0].bbox[0]).toBeLessThan(0.09);
    expect(found[0].bbox[2]).toBeGreaterThan(0.54);
    expect(found[0].bbox[2]).toBeLessThan(0.65);
    expect(found[0].context).toContain('Figure caption');
    expect(found[0].context).not.toContain('RIGHT secret');
    const firstProfile = found[0].analysisProfile;
    manifest = 'new-local-model';
    expect((await run('vector'))[0].analysisProfile).toBe(firstProfile);
    expect(calls).toEqual([]);
  });
  it('allows disabling native vector fast path to force model semantics', async () => {
    regions = [{ kind: 'figure', bbox: [0.08, 0.18, 0.56, 0.28], score: 0.97 }];
    expect(await run('vector')).toHaveLength(1);
    expect(calls).toContain('standard');
  });
  it('uses painted grid boundaries for native table fast path', async () => {
    config.set('PDF_ANALYSIS_NATIVE_FAST_PATH', true);
    const found = await run('grid-table');
    expect(found).toHaveLength(1);
    expect(found[0].recognition).toBe('vision');
    expect(calls).toEqual([]);
  });
  it.each([
    'vector-sparse',
    'vector-empty',
    'vector-large',
    'image-native-inside',
    'image-native-overlay',
    'image-large',
    'scan-native',
    'scan',
  ] as const)(
    'keeps model analysis for %s when native vector evidence is insufficient',
    async (kind) => {
      config.set('PDF_ANALYSIS_NATIVE_FAST_PATH', true);
      regions = [{ kind: 'unknown', bbox: [0.08, 0.18, 0.56, 0.28], score: 0.5 }];
      await run(kind);
      expect(calls).toContain('standard');
    },
  );
  it.each(['vector-image', 'image-native-prose'] as const)(
    'sends a well bounded %s directly to vision when native prose outside it is reliable',
    async (kind) => {
      config.set('PDF_ANALYSIS_NATIVE_FAST_PATH', true);
      const found = await run(kind);
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((r) => r.recognition === 'vision')).toBe(true);
      expect(calls).toEqual([]);
    },
  );
  it('keeps corrupt native extraction and its legacy fallback on model analysis', async () => {
    config.set('PDF_ANALYSIS_NATIVE_FAST_PATH', true);
    const f = await fixture('vector');
    try {
      const found = await locateHybridRegions(
        f.document,
        f.page,
        '\uFFFD' + f.native,
        f.content,
        scope,
        client,
      );
      expect(calls).toContain('standard');
      expect(found[0]?.kind).toBe('fallback');
      expect(found[0]?.recognition).toBe('vision');
    } finally {
      await f.task.destroy();
    }
  });
  it('still sends a borderless native table to layout when fast path is enabled', async () => {
    config.set('PDF_ANALYSIS_NATIVE_FAST_PATH', true);
    regions = [{ kind: 'table', bbox: [0.07, 0.11, 0.67, 0.29], score: 0.96 }];
    expect(await run('table')).toHaveLength(1);
    expect(calls).toContain('standard');
  });
  it('makes no service request for an entirely blank page', async () => {
    expect(await run('blank')).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('does not treat nonpainting clipping paths around native text as graphics', async () => {
    expect(await run('clipped-text')).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('skips model layout when only a decorative rule remains beside reliable native prose', async () => {
    expect(await run('ruled-text')).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('accepts native coverage for a short model text region', async () => {
    regions = [{ kind: 'text', bbox: [0.095, 0.114, 0.15, 0.134], score: 0.99 }];
    expect(await run('short-native')).toEqual([]);
  });
  it('does not rerun layout for a low-confidence title fully covered by native text', async () => {
    regions = [{ kind: 'title', bbox: [0.05, 0.07, 0.37, 0.094], score: 0.6 }];
    expect(await run('scan-native')).toEqual([]);
    expect(calls).toEqual(['health', 'standard']);
  });
  it('detects a borderless table from repeated column alignment', async () => {
    regions = [{ kind: 'table', bbox: [0.07, 0.11, 0.67, 0.29], score: 0.96 }];
    expect(await run('table')).toMatchObject([{ recognition: 'vision', kind: 'region' }]);
    expect(calls).toContain('standard');
  });
  it('checks a two-row borderless table instead of taking the native prose shortcut', async () => {
    regions = [{ kind: 'table', bbox: [0.07, 0.11, 0.67, 0.2], score: 0.96 }];
    expect((await run('table-short'))[0]?.recognition).toBe('vision');
    expect(calls).toContain('standard');
  });
  it('keeps a complete native-labelled vector diagram and its caption within one column', async () => {
    regions = [{ kind: 'figure', bbox: [0.08, 0.18, 0.56, 0.28], score: 0.97 }];
    const found = await run('vector');
    expect(found).toHaveLength(1);
    expect(found[0].bbox[0]).toBeLessThan(0.09);
    expect(found[0].bbox[2]).toBeGreaterThan(0.54);
    expect(found[0].bbox[2]).toBeLessThan(0.65);
    expect(found[0].context).toContain('Figure caption');
    expect(found[0].context).not.toContain('RIGHT secret');
  });
  it('suppresses legacy outlined glyph candidates explained by confident native text', async () => {
    regions = [{ kind: 'text', bbox: [0.05, 0.07, 0.37, 0.094], score: 0.99 }];
    expect(await run('glyph')).toEqual([]);
  });
  it('uses focused OCR for scan text and vision only for scan figures', async () => {
    regions = [
      { kind: 'text', bbox: [0.05, 0.05, 0.9, 0.3], score: 0.98 },
      { kind: 'figure', bbox: [0.1, 0.5, 0.8, 0.8], score: 0.96 },
    ];
    const found = await run('scan');
    expect(found).toHaveLength(2);
    expect(found.map((r) => r.recognition)).toEqual(['ocr', 'vision']);
    expect(found.every((r) => r.kind === 'region')).toBe(true);
    expect(found[0].ocrExpectedBoxes).toEqual([[0.05, 0.05, 0.9, 0.3]]);
  });
  it('does not mistake a native header for coverage of an entire scanned paragraph', async () => {
    regions = [{ kind: 'text', bbox: [0.05, 0.05, 0.9, 0.5], score: 0.99 }];
    const found = await run('scan-native');
    expect(found).toHaveLength(1);
    expect(found[0].recognition).toBe('ocr');
  });
  it('skips OCR when the native layer reliably covers the scan text region', async () => {
    regions = [{ kind: 'text', bbox: [0.05, 0.07, 0.37, 0.094], score: 0.99 }];
    expect(await run('scan-native')).toEqual([]);
  });
  it('does not mistake recovered first and last lines for complete native OCR coverage', async () => {
    regions = [{ kind: 'text', bbox: [0.1, 0.1, 0.9, 0.8], score: 0.99 }];
    expect((await run('scan-sparse')).some((r) => r.recognition === 'ocr')).toBe(true);
  });
  it('does not expand a small figure to its enclosing decorative page frame', async () => {
    regions = [
      { kind: 'figure', bbox: [0.13, 0.25, 0.3, 0.325], score: 0.99 },
      { kind: 'decoration', bbox: [0.1, 0.15, 0.9, 0.8], score: 0.99 },
    ];
    const result = await run('framed-vector');
    expect(result).toHaveLength(1);
    const b = result[0].bbox;
    expect((b[2] - b[0]) * (b[3] - b[1])).toBeLessThan(0.1);
  });
  it('rechecks low confidence and retains unexplained graphics conservatively', async () => {
    regions = [{ kind: 'unknown', bbox: [0.08, 0.18, 0.56, 0.28], score: 0.5 }];
    const found = await run('vector');
    expect(calls).toContain('high');
    expect(found.some((r) => r.recognition === 'vision')).toBe(true);
  });
  it('retains painted vector nodes and connectors when the local layout model misses them', async () => {
    regions = [{ kind: 'text', bbox: [0.05, 0.07, 0.37, 0.094], score: 0.99 }];
    const found = await run('vector');
    expect(calls).toContain('high');
    expect(found).toHaveLength(1);
    expect(found[0].recognition).toBe('vision');
    expect(found[0].bbox[0]).toBeLessThan(0.09);
    expect(found[0].bbox[2]).toBeGreaterThan(0.54);
  });
  it('rechecks uncertain decoration rather than dropping a suspected borderless table', async () => {
    client.layout = async (_bytes, precision) => {
      calls.push(precision);
      return {
        manifest,
        regions:
          precision === 'standard'
            ? [{ kind: 'decoration', bbox: [0.07, 0.11, 0.67, 0.29], score: 0.4 }]
            : [{ kind: 'table', bbox: [0.07, 0.11, 0.67, 0.29], score: 0.96 }],
      };
    };
    const found = await run('table');
    expect(found).toHaveLength(1);
    expect(found[0].recognition).toBe('vision');
    expect(calls).toContain('high');
  });
  it('keeps an uncertain region after the high precision recheck also calls it decoration', async () => {
    regions = [{ kind: 'decoration', bbox: [0.07, 0.11, 0.67, 0.29], score: 0.4 }];
    const found = await run('table');
    expect(found).toHaveLength(1);
    expect(found[0].recognition).toBe('vision');
  });
  it('reuses layout cache only within the same scope and current model manifest', async () => {
    regions = [{ kind: 'figure', bbox: [0.08, 0.18, 0.56, 0.28], score: 0.97 }];
    await run('vector');
    await run('vector');
    expect(calls.filter((c) => c === 'standard')).toHaveLength(1);
    manifest = 'layout-b';
    await run('vector');
    expect(calls.filter((c) => c === 'standard')).toHaveLength(2);
    await run('vector', { ...scope, userId: 9 });
    expect(calls.filter((c) => c === 'standard')).toHaveLength(3);
  });
  it('preserves a guard cancellation before reading cache or calling a service', async () => {
    const f = await fixture('scan');
    const error = new Error('version deleted');
    try {
      await expect(
        locateHybridRegions(
          f.document,
          f.page,
          '',
          f.content,
          {
            ...scope,
            guard: async () => {
              throw error;
            },
          },
          client,
        ),
      ).rejects.toBe(error);
      expect(calls).toEqual([]);
    } finally {
      await f.task.destroy();
    }
  });
});
