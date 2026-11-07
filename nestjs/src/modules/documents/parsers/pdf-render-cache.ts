import { localRendering } from './vision-scheduler';
import { RegionBox } from './parsed-document';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

interface RenderScope {
  signal?: AbortSignal;
  guard?: () => Promise<unknown>;
}
/** Warm hits verify PNG integrity without retaining a whole image outside the
 * bounded image producer pool. Stream chunks stay bounded to 64 KiB each.
 */
export async function verifyCachedPdfImage(
  path: string,
  expectedBytes: number,
  expectedHash: string,
  scope: RenderScope,
): Promise<boolean> {
  await scope.guard?.();
  scope.signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(expectedHash)
  )
    return false;
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size !== expectedBytes) return false;
  const hash = createHash('sha256');
  let actualBytes = 0;
  const stream = createReadStream(path, { highWaterMark: 64 * 1024, signal: scope.signal });
  try {
    for await (const chunk of stream) {
      scope.signal?.throwIfAborted();
      hash.update(chunk);
      actualBytes += chunk.length;
    }
  } catch (error) {
    scope.signal?.throwIfAborted();
    throw error;
  }
  await scope.guard?.();
  scope.signal?.throwIfAborted();
  return actualBytes === expectedBytes && hash.digest('hex') === expectedHash;
}
interface Raster {
  canvas: any;
  scale: number;
}
// One lazy raster slot across every page/session. The local rendering mutex
// makes page eviction, creation and cropping atomic, without locking network I/O.
const pageLeases = new WeakMap<object, number>();
let current: { page: object; document: any; raster: Raster } | undefined;
function evict() {
  if (current) current.document.canvasFactory.destroy(current.raster.canvas);
  current = undefined;
}
/** Call only while holding localRendering (also used by low-resolution layout). */
export function discardPdfPageRaster() {
  evict();
}

export async function withPdfPageRaster<T>(
  document: any,
  page: any,
  scope: RenderScope,
  work: () => Promise<T>,
): Promise<T> {
  pageLeases.set(page, (pageLeases.get(page) || 0) + 1);
  try {
    await scope.guard?.();
    return await work();
  } finally {
    const remaining = (pageLeases.get(page) || 1) - 1;
    if (remaining) pageLeases.set(page, remaining);
    else {
      pageLeases.delete(page);
      await localRendering.run(async () => {
        if (current?.page === page) evict();
      });
    }
  }
}

export function pdfRegionScale(width: number, height: number, limit?: number) {
  return (
    2 *
    Math.min(
      1,
      limit ? limit / 2 : 1,
      Math.sqrt(8000000 / (width * height * 4)),
      4096 / (Math.max(width, height) * 2),
    )
  );
}

export async function renderPdfRegion(
  document: any,
  page: any,
  region: { bbox: RegionBox; scaleLimit?: number },
  scope: RenderScope,
): Promise<Buffer> {
  await scope.guard?.();
  return localRendering.run(async () => {
    await scope.guard?.();
    const base = page.getViewport({ scale: 1 });
    const [x0, y0, x1, y1] = region.bbox;
    const width = base.width * (x1 - x0),
      height = base.height * (y1 - y0);
    const scale = pdfRegionScale(width, height, region.scaleLimit);
    const fullScale = pdfRegionScale(base.width, base.height);
    const lease = pageLeases.has(page);
    // Do not trade fine print for reuse. A small crop can afford higher
    // resolution than a bounded raster of a very large page.
    if (lease && fullScale >= scale - 1e-9) {
      if (!current || current.page !== page || current.raster.scale !== fullScale) {
        evict();
        const viewport = page.getViewport({ scale: fullScale });
        const canvas = document.canvasFactory.create(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        try {
          await page.render({ canvas: canvas.canvas, canvasContext: canvas.context, viewport })
            .promise;
          current = { page, document, raster: { canvas, scale: fullScale } };
        } catch (error) {
          document.canvasFactory.destroy(canvas);
          throw error;
        }
      }
      const crop = document.canvasFactory.create(
        Math.ceil(width * scale),
        Math.ceil(height * scale),
      );
      try {
        crop.context.drawImage(
          current!.raster.canvas.canvas,
          x0 * base.width * fullScale,
          y0 * base.height * fullScale,
          width * fullScale,
          height * fullScale,
          0,
          0,
          Math.ceil(width * scale),
          Math.ceil(height * scale),
        );
        return crop.canvas.toBuffer('image/png');
      } finally {
        document.canvasFactory.destroy(crop);
      }
    }
    const viewport = page.getViewport({ scale });
    const canvas = document.canvasFactory.create(
      Math.ceil(width * scale),
      Math.ceil(height * scale),
    );
    try {
      await page.render({
        canvas: canvas.canvas,
        canvasContext: canvas.context,
        viewport,
        transform: [1, 0, 0, 1, -x0 * viewport.width, -y0 * viewport.height],
      }).promise;
      return canvas.canvas.toBuffer('image/png');
    } finally {
      document.canvasFactory.destroy(canvas);
    }
  }, scope.signal);
}
