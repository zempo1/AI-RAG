import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PdfVisualService } from '../src/modules/documents/parsers/pdf-visual.service';
import { PageAssetsService } from '../src/modules/documents/page-assets.service';
import { MemoryStore } from '../src/persistence/memory.store';
import PDFDocument from 'pdfkit';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';

const scope = { userId: 1, documentId: 1, versionId: 1 };
const profile = 'a'.repeat(64);
const region = {
  bbox: [0, 0, 0.5, 0.5],
  kind: 'region',
  context: 'exact context',
  textIndexes: [],
  recognition: 'ocr',
  analysisProfile: 'ocr-v1',
};
function fixture() {
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
  return { document, page };
}
describe('hybrid PDF recognition', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdf-hybrid-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  function setup(
    ocr: () => Promise<any>,
    complete = async () =>
      JSON.stringify({ blocks: [{ type: 'figure', text: 'fallback diagram' }] }),
  ) {
    const config = new ConfigService({ PAGE_ASSETS_DIR: dir, PDF_ANALYSIS_MODE: 'hybrid' });
    const visual: any = new PdfVisualService(
      config,
      { complete } as any,
      new PageAssetsService(config, new MemoryStore()),
    );
    visual.analysis = { ocr };
    const f = fixture();
    return {
      ...f,
      visual,
      run: (r = region, p = f.page, s = scope) =>
        visual.region(f.document, p, '', s, profile, r, 1),
    };
  }
  it('reports OCR and vision with completed region counts and never regresses the recognition stage', async () => {
    const pdf = new PDFDocument();
    const pieces: Buffer[] = [];
    const bytes = new Promise<Buffer>((resolve) => {
      pdf.on('data', (b) => pieces.push(b));
      pdf.on('end', () => resolve(Buffer.concat(pieces)));
    });
    pdf.text('native');
    pdf.end();
    const stages: any[] = [];
    const visual: any = {
      enabled: true,
      hybrid: true,
      concurrency: 1,
      page: async (_d: any, _p: any, _n: any, s: any) => {
        await s.discovered(2);
        await s.stage('ocr', 1, 1);
        await s.completed();
        await s.stage('vision', 1, 1);
        await s.stage('ocr', 1, 1);
        await s.completed();
        return { blocks: [] };
      },
    };
    await new DocumentParser(visual).parseStructured(await bytes, 'a.pdf', undefined, {
      ...scope,
      stage: async (...args) => {
        stages.push(args);
      },
    });
    expect(stages[0]).toEqual(['ocr', 0, 2]);
    expect(stages.at(-1)).toEqual(['vision', 2, 2]);
    const firstVision = stages.findIndex((row) => row[0] === 'vision');
    expect(stages.slice(firstVision).every((row) => row[0] === 'vision')).toBe(true);
  });
  it('keeps native fast-path cache independent of another page loading a local model', async () => {
    const f = setup(async () => { throw new Error('OCR must not run'); });
    const target = { ...region, recognition: 'vision' };
    await f.run(target);
    f.visual.analysis.modelManifest = 'local-model-loaded-by-another-page';
    f.page.render = () => { throw new Error('cached PNG must not be rendered again'); };
    expect((await f.run(target))[0].text).toBe('fallback diagram');
  });
  it('recognizes text regions locally and reuses identical OCR images across pages with fresh references', async () => {
    let calls = 0,
      vision = 0;
    const f = setup(
      async () => {
        calls++;
        return {
          manifest: 'ocr-v1',
          blocks: [{ text: 'local text', bbox: [0, 0, 1, 1], score: 0.99 }],
        };
      },
      async () => {
        vision++;
        return '{}';
      },
    );
    const a = await f.run();
    const b = await f.run(region, { ...f.page, pageNumber: 2 });
    expect(a[0].text).toBe('local text');
    expect(b[0].regionImage.page).toBe(2);
    expect(calls).toBe(1);
    expect(vision).toBe(0);
  });
  it('uses vision for low-confidence OCR, but propagates service transport failures', async () => {
    let vision = 0;
    const f = setup(
      async () => ({
        manifest: 'ocr-v1',
        blocks: [{ text: 'uncertain', bbox: [0, 0, 1, 1], score: 0.1 }],
      }),
      async () => {
        vision++;
        return JSON.stringify({ blocks: [{ type: 'figure', text: 'fallback diagram' }] });
      },
    );
    expect((await f.run())[0].text).toBe('fallback diagram');
    expect(vision).toBe(1);
    const error = new Error('local OCR unavailable');
    const failing = setup(
      async () => {
        throw error;
      },
      async () => {
        vision++;
        return '{}';
      },
    );
    await expect(
      failing.run({ ...region, bbox: [0.5, 0.5, 1, 1] }, failing.page, { ...scope, versionId: 2 }),
    ).rejects.toBe(error);
    expect(vision).toBe(1);
  });
  it('preserves high-confidence OCR and sends only uncovered layout text to local vision fallback', async () => {
    let vision = 0;
    const f = setup(
      async () => ({
        manifest: 'ocr-v1',
        blocks: [{ text: 'recognized left', bbox: [0, 0, 0.4, 1], score: 0.99 }],
      }),
      async () => {
        vision++;
        return JSON.stringify({ blocks: [{ type: 'ocr', text: 'missing right' }] });
      },
    );
    const blocks = await f.run({
      ...region,
      bbox: [0, 0, 1, 1],
      ocrExpectedBoxes: [
        [0, 0, 0.4, 1],
        [0.6, 0, 1, 1],
      ],
    } as any);
    expect(blocks.map((b: any) => b.text)).toEqual(['recognized left', 'missing right']);
    expect(vision).toBe(1);
  });
  it('accepts complete high-confidence lines with normal line spacing and a short final line', async () => {
    let vision = 0;
    const lines = Array.from({ length: 10 }, (_, i) => ({
      text: 'line ' + i,
      bbox: [0.05, i / 10, i === 9 ? 0.3 : 0.95, i / 10 + 0.055],
      score: 0.99,
    }));
    const f = setup(
      async () => ({ manifest: 'ocr-v1', blocks: lines }),
      async () => {
        vision++;
        return JSON.stringify({ blocks: [] });
      },
    );
    const blocks = await f.run({
      ...region,
      bbox: [0, 0, 1, 1],
      ocrExpectedBoxes: [[0.05, 0, 0.95, 0.955]],
    } as any);
    expect(blocks).toHaveLength(10);
    expect(vision).toBe(0);
  });
  it('detects an omitted text row between high-confidence rows and limits fallback to the gap', async () => {
    let fallbackHeight = 0;
    const lines = Array.from({ length: 10 }, (_, i) => ({
      text: 'line ' + i,
      bbox: [0.05, i / 10, 0.95, i / 10 + 0.055],
      score: 0.99,
    })).filter((_, i) => i !== 5);
    const f = setup(
      async () => ({ manifest: 'ocr-v1', blocks: lines }),
      async (_prompt: any, _key: any, images: any[]) => {
        fallbackHeight = (await loadImage(Buffer.from(images[0].dataUrl.split(',')[1], 'base64')))
          .height;
        return JSON.stringify({ blocks: [{ type: 'ocr', text: 'missing line 5' }] });
      },
    );
    const blocks = await f.run({
      ...region,
      bbox: [0, 0, 1, 1],
      ocrExpectedBoxes: [[0.05, 0, 0.95, 0.955]],
    } as any);
    expect(blocks.map((b: any) => b.text)).toContain('missing line 5');
    expect(fallbackHeight).toBeGreaterThan(0);
    expect(fallbackHeight).toBeLessThan(120); // Main input is 400px high.
  });
  it('never reuses visual descriptions across distinct exact context', async () => {
    let calls = 0;
    const f = setup(
      async () => {
        throw new Error('unused');
      },
      async () => {
        calls++;
        return JSON.stringify({ blocks: [{ type: 'figure', text: String(calls) }] });
      },
    );
    const visualRegion = { ...region, recognition: 'vision' };
    const a = await f.run(visualRegion);
    const b = await f.run(
      { ...visualRegion, context: 'different context' },
      { ...f.page, pageNumber: 2 },
    );
    expect(a[0].text).toBe('1');
    expect(b[0].text).toBe('2');
    expect(calls).toBe(2);
  });
  function pageSetup(
    count: number,
    complete: (...args: any[]) => Promise<string>,
    concurrency = 3,
  ) {
    const config = new ConfigService({
      PAGE_ASSETS_DIR: dir,
      PDF_ANALYSIS_MODE: 'hybrid',
      VISION_CONCURRENCY: concurrency,
    });
    const visual: any = new PdfVisualService(
      config,
      { complete } as any,
      new PageAssetsService(config, new MemoryStore()),
    );
    const boxes = Array.from({ length: count }, (_, i) => [
      0.1,
      (i + 0.1) / count,
      0.9,
      (i + 0.8) / count,
    ]);
    visual.analysis = {
      modelManifest: 'bundle-v1',
      health: async () => ({ ready: true, manifest: 'bundle-v1' }),
      cacheDirectory: () => undefined,
      layout: async () => ({
        manifest: 'bundle-v1',
        regions: boxes.map((bbox) => ({ kind: 'figure', bbox, score: 0.99 })),
      }),
    };
    const f = fixture();
    let renders = 0;
    const page = {
      ...f.page,
      getOperatorList: async () => ({
        fnArray: [(await import('pdfjs-dist/legacy/build/pdf.mjs')).OPS.showText],
        argsArray: [[]],
      }),
      render: ({ canvasContext: ctx, viewport, transform }: any) => {
        renders++;
        ctx.save();
        if (transform) ctx.transform(...transform);
        boxes.forEach((b, i) => {
          ctx.fillStyle = `rgb(${20 + i * 30},40,70)`;
          ctx.fillRect(
            b[0] * viewport.width,
            b[1] * viewport.height,
            (b[2] - b[0]) * viewport.width,
            (b[3] - b[1]) * viewport.height,
          );
        });
        ctx.restore();
        return { promise: Promise.resolve() };
      },
    };
    return {
      visual,
      document: f.document,
      page,
      get renders() {
        return renders;
      },
      run: (s = scope) => visual.page(f.document, page, '', s, { items: [] }),
    };
  }
  it('runs regions within a page concurrently, preserves region order and reuses one page render', async () => {
    let active = 0,
      peak = 0,
      calls = 0;
    const f = pageSetup(3, async (_prompt: string, _key: any, images: any[]) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      const image = await loadImage(Buffer.from(images[0].dataUrl.split(',')[1], 'base64'));
      const canvas = createCanvas(1, 1),
        ctx = canvas.getContext('2d');
      ctx.drawImage(image, image.width / 2, image.height / 2, 1, 1, 0, 0, 1, 1);
      const id = Math.round((ctx.getImageData(0, 0, 1, 1).data[0] - 20) / 30) + 1;
      await new Promise((r) => setTimeout(r, (4 - id) * 15));
      active--;
      return JSON.stringify({ blocks: [{ type: 'figure', text: 'figure ' + id }] });
    });
    const result = await f.run();
    expect(peak).toBe(3);
    expect(result.blocks.map((b: any) => b.text)).toEqual(['figure 1', 'figure 2', 'figure 3']);
    expect(f.renders).toBe(2); // low-resolution layout + one shared region raster
    await f.run();
    expect(calls).toBe(3);
  });
  it('stops scheduling after the first failure and lets in-flight successes settle into cache', async () => {
    let active = 0,
      calls = 0,
      fail = true;
    const error = new Error('first request failed');
    const f = pageSetup(6, async () => {
      const id = ++calls;
      active++;
      try {
        await new Promise((r) => setTimeout(r, id === 1 ? 5 : 30));
        if (id === 1 && fail) throw error;
        return JSON.stringify({ blocks: [{ type: 'figure', text: 'figure ' + id }] });
      } finally {
        active--;
      }
    });
    await expect(f.run()).rejects.toBe(error);
    expect(active).toBe(0);
    expect(calls).toBe(3);
    fail = false;
    const result = await f.run();
    expect(result.blocks).toHaveLength(6);
    expect(calls).toBe(7); // two successful in-flight regions were preserved
  });
  it('shares configured concurrency across sessions', async () => {
    let active = 0,
      peak = 0;
    const f = pageSetup(
      3,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return JSON.stringify({ blocks: [{ type: 'figure', text: 'one slot' }] });
      },
      1,
    );
    await Promise.all([f.run({ ...scope, versionId: 2 }), f.run({ ...scope, versionId: 3 })]);
    expect(peak).toBe(1);
  });
  it('does not share a canceled session singleflight with another session', async () => {
    let calls = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const error = new Error('first session canceled');
    const f = setup(async () => {
      const id = ++calls;
      if (id === 1) started();
      await new Promise((r) => setTimeout(r, 40));
      if (id === 1) throw error;
      return {
        manifest: 'ocr-v1',
        blocks: [{ text: 'second session result', bbox: [0, 0, 1, 1], score: 0.99 }],
      };
    });
    const first = f.run(region, f.page, { ...scope, signal: new AbortController().signal } as any);
    await firstStarted;
    const second = f.run(region, { ...f.page, pageNumber: 2 }, {
      ...scope,
      signal: new AbortController().signal,
    } as any);
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(calls).toBe(2);
  });
  it('treats structurally corrupt OCR and vision result caches as misses', async () => {
    let ocrCalls = 0,
      visionCalls = 0;
    const f = setup(
      async () => {
        ocrCalls++;
        return {
          manifest: 'ocr-v1',
          blocks: [{ text: 'valid OCR', bbox: [0, 0, 1, 1], score: 0.99 }],
        };
      },
      async () => {
        visionCalls++;
        return JSON.stringify({ blocks: [{ type: 'figure', text: 'valid vision' }] });
      },
    );
    await f.run();
    const cache = join(
      dir,
      '1',
      '1',
      '1',
      createHash('sha256').update('pdf-hybrid-recognition-v1').digest('hex'),
      'recognition',
    );
    const ocrFile = (await readdir(cache)).find((name) => /^ocr-[a-f0-9]{64}\.json$/.test(name))!;
    await writeFile(
      join(cache, ocrFile),
      JSON.stringify({
        manifest: 'ocr-v1',
        blocks: [{ text: 'corrupt OCR', bbox: [0, 0, 1, 1], score: 'invalid' }],
      }),
    );
    expect((await f.run(region, { ...f.page, pageNumber: 2 }))[0].text).toBe('valid OCR');
    expect(ocrCalls).toBe(2);
    await f.run({ ...region, recognition: 'vision' }, { ...f.page, pageNumber: 3 });
    const visionFile = (await readdir(cache)).find((name) => name.startsWith('vision-'))!;
    await writeFile(
      join(cache, visionFile),
      JSON.stringify([{ type: 'invalid', text: 'corrupt vision' }]),
    );
    expect(
      (await f.run({ ...region, recognition: 'vision' }, { ...f.page, pageNumber: 4 }))[0].text,
    ).toBe('valid vision');
    expect(visionCalls).toBe(2);
  });
  it('preserves progress guard errors on region cache hits without retrying recognition', async () => {
    let calls = 0;
    const f = setup(async () => {
      calls++;
      return {
        manifest: 'ocr-v1',
        blocks: [{ text: 'cached OCR', bbox: [0, 0, 1, 1], score: 0.99 }],
      };
    });
    await f.run();
    class Superseded extends Error {}
    const error = new Superseded('replaced');
    await expect(
      f.run(region, f.page, {
        ...scope,
        completed: async () => {
          throw error;
        },
      } as any),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  });
  it('checks a warm cached PNG without rendering and regenerates a tampered PNG', async () => {
    let calls = 0,
      renders = 0;
    const f = setup(async () => {
      calls++;
      return {
        manifest: 'ocr-v1',
        blocks: [{ text: 'cached OCR', bbox: [0, 0, 1, 1], score: 0.99 }],
      };
    });
    const render = f.page.render;
    f.page.render = () => {
      renders++;
      return render();
    };
    const first = await f.run();
    const ref = first[0].regionImage;
    const png = join(dir, '1', '1', '1', ref.profile, `${ref.page}-${ref.regionId}.png`);
    const initial = await readFile(png);
    await f.run();
    expect(renders).toBe(1);
    const corrupted = Buffer.from(initial);
    corrupted[corrupted.length - 1] ^= 1;
    await writeFile(png, corrupted);
    await f.run();
    expect(renders).toBe(2);
    expect(calls).toBe(1); // Pixel result cache still reuses the regenerated image.
    expect((await readFile(png)).equals(initial)).toBe(true);
  });
});
