import { createCanvas } from '@napi-rs/canvas';
import {
  renderPdfRegion,
  withPdfPageRaster,
  verifyCachedPdfImage,
} from '../src/modules/documents/parsers/pdf-render-cache';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function fixture(width = 600, height = 800) {
  let renders = 0,
    live = 0,
    peak = 0;
  const document = {
    canvasFactory: {
      create(w: number, h: number) {
        live++;
        peak = Math.max(peak, live);
        const canvas = createCanvas(w, h);
        return { canvas, context: canvas.getContext('2d') };
      },
      destroy() {
        live--;
      },
    },
  };
  const page = {
    getViewport: ({ scale }: any) => ({ width: width * scale, height: height * scale }),
    render({ canvasContext }: any) {
      renders++;
      canvasContext.fillRect(0, 0, 30, 30);
      return { promise: Promise.resolve() };
    },
  };
  return {
    document,
    page,
    get renders() {
      return renders;
    },
    get live() {
      return live;
    },
    get peak() {
      return peak;
    },
  };
}
const region = { bbox: [0, 0, 0.25, 0.25] as [number, number, number, number] };

it('renders a page once while cropping multiple regions and releases its raster', async () => {
  const f = fixture();
  await withPdfPageRaster(f.document, f.page, {}, async () => {
    const [a, b] = await Promise.all([
      renderPdfRegion(f.document, f.page, region, {}),
      renderPdfRegion(f.document, f.page, region, {}),
    ]);
    expect(a.equals(b)).toBe(true);
    expect(f.renders).toBe(1);
  });
  expect(f.live).toBe(0);
});

it('uses local region rendering when a bounded page raster would lose small text resolution', async () => {
  const f = fixture(5000, 5000);
  await withPdfPageRaster(f.document, f.page, {}, async () => {
    await renderPdfRegion(f.document, f.page, region, {});
    await renderPdfRegion(f.document, f.page, region, {});
  });
  expect(f.renders).toBe(2);
  expect(f.live).toBe(0);
});

it('never keeps two full page rasters resident across concurrent page leases', async () => {
  const f = fixture();
  const second = { ...f.page };
  await Promise.all(
    [f.page, second].map((page) =>
      withPdfPageRaster(f.document, page, {}, async () => {
        await renderPdfRegion(f.document, page, region, {});
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
    ),
  );
  // One full page plus one short-lived crop canvas.
  expect(f.peak).toBeLessThanOrEqual(2);
  expect(f.live).toBe(0);
});

it('validates cached image bytes incrementally and rejects same-size tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-cache-image-'));
  const path = join(root, 'large.png');
  const bytes = Buffer.alloc(1024 * 1024, 42);
  const hash = createHash('sha256').update(bytes).digest('hex');
  try {
    await writeFile(path, bytes);
    expect(await verifyCachedPdfImage(path, bytes.length, hash, {})).toBe(true);
    await writeFile(path, Buffer.alloc(bytes.length, 43));
    expect(await verifyCachedPdfImage(path, bytes.length, hash, {})).toBe(false);
    const error = new Error('superseded');
    await expect(
      verifyCachedPdfImage(path, bytes.length, hash, {
        guard: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
