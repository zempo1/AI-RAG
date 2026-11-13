import { RegionBox } from './parsed-document';
import { createHash } from 'node:crypto';

export interface TextPosition {
  text: string;
  bbox: RegionBox;
  index: number;
}
export interface PdfRegion {
  /** Original graphic bounds, before nearby text/caption expansion. */
  inkBox?: RegionBox;
  bbox: RegionBox;
  kind: 'region' | 'scan' | 'fallback';
  reason?: string;
  context: string;
  textIndexes: number[];
  scaleLimit?: number;
  rasterOnly?: boolean;
  recognition?: 'ocr' | 'vision' | 'classify';
  analysisProfile?: string;
}

/** Consolidate adjacent, already-expanded crops within one narrow column. */
export function groupNearbyCrops(
  regions: PdfRegion[],
  scale: (box: RegionBox, limit?: number) => number,
): PdfRegion[] {
  const grouped: PdfRegion[] = [];
  for (const region of regions) {
    if (region.kind !== 'region') {
      grouped.push(region);
      continue;
    }
    const b = region.bbox;
    const index = grouped.findIndex((item) => {
      if (item.kind !== 'region' || item.scaleLimit !== region.scaleLimit ||
          item.rasterOnly || region.rasterOnly) return false;
      const a = item.bbox;
      const merged = union(a, b);
      const horizontalOverlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      return (
        merged[2] - merged[0] <= 1 / 3 &&
        horizontalOverlap >= 0.6 * Math.min(a[2] - a[0], b[2] - b[0]) &&
        b[1] - a[3] <= 0.06 &&
        area(merged) <= 1.25 * (area(a) + area(b)) &&
        scale(merged, item.scaleLimit) >= Math.max(scale(a, item.scaleLimit), scale(b, region.scaleLimit))
      );
    });
    if (index < 0) {
      grouped.push(region);
      continue;
    }
    const item = grouped[index];
    grouped[index] = {
      ...item,
      inkBox: union(item.inkBox ?? item.bbox, region.inkBox ?? b),
      bbox: union(item.bbox, b),
      context: [...new Set([...item.context.split('\n'), ...region.context.split('\n')])]
        .filter(Boolean)
        .join('\n')
        .slice(0, 4000),
      textIndexes: [...new Set([...item.textIndexes, ...region.textIndexes])].sort((a, b) => a - b),
    };
  }
  return grouped;
}
const area = (b: RegionBox) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const union = (a: RegionBox, b: RegionBox): RegionBox => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const near = (a: RegionBox, b: RegionBox, gap: number) =>
  a[0] <= b[2] + gap && b[0] <= a[2] + gap && a[1] <= b[3] + gap && b[1] <= a[3] + gap;
const clamp = (b: RegionBox): RegionBox => b.map((v) => Math.max(0, Math.min(1, v))) as RegionBox;
const imageNames = [
  'paintImageXObject',
  'paintInlineImageXObject',
  'paintImageXObjectRepeat',
  'paintImageMaskXObject',
  'paintImageMaskXObjectRepeat',
  'paintImageMaskXObjectGroup',
  'paintInlineImageXObjectGroup',
];

/** PDF.js packs the terminating paint operation into constructPath[0].
 * endPath only installs a clip; its recorded bounds may include dependent text.
 */
export function hasPdfGraphics(list: any, ops: any): boolean {
  const painted = new Set([...imageNames.map((n) => ops[n]), ops.shadingFill]);
  return list.fnArray.some(
    (op: number, i: number) =>
      painted.has(op) || (op === ops.constructPath && list.argsArray[i]?.[0] !== ops.endPath),
  );
}
const decorationCache = new WeakMap<object, Promise<Set<string>>>();
const imageSignatures = new WeakMap<object, { hash: string; meanAlpha: number; maxAlpha: number }>();

function imageSignature(object: any) {
  let signature = imageSignatures.get(object);
  if (signature) return signature;
  let meanAlpha = 1, maxAlpha = 1;
  if (object.kind === 3 && object.data.length === object.width * object.height * 4) {
    let sum = 0, max = 0;
    for (let i = 3; i < object.data.length; i += 4) {
      sum += object.data[i];
      max = Math.max(max, object.data[i]);
    }
    meanAlpha = sum / (255 * object.width * object.height);
    maxAlpha = max / 255;
  }
  signature = {
    hash: createHash('sha256').update(object.data).digest('hex'),
    meanAlpha,
    maxAlpha,
  };
  imageSignatures.set(object, signature);
  return signature;
}

async function operationInfo(list: any, ops: any, page: any) {
  // 图片解码可晚于 operator list 返回；先等依赖，避免首次和重试得到不同指纹。
  const ids = new Set<string>(
    list.fnArray
      .map((op: number, i: number) =>
        imageNames.some((name) => ops[name] === op) && typeof list.argsArray[i][0] === 'string'
          ? list.argsArray[i][0]
          : '',
      )
      .filter(Boolean),
  );
  await Promise.all(
    [...ids].map((id) => {
      const pool = id.startsWith('g_') ? page.commonObjs : page.objs;
      if (!pool || pool.has(id)) return;
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500);
        pool.get(id, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }),
  );
  let alpha = 1,
    transform = [1, 0, 0, 1, 0, 0];
  const stack: { alpha: number; transform: number[] }[] = [];
  const multiply = (a: number[], b: number[]) => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  return (list.fnArray as number[]).map((op, i) => {
    const args = list.argsArray[i];
    if (op === ops.save || op === ops.paintFormXObjectBegin) {
      stack.push({ alpha, transform: [...transform] });
      if (op === ops.paintFormXObjectBegin && args[0])
        transform = multiply(transform, Array.from(args[0]));
    } else if (op === ops.restore || op === ops.paintFormXObjectEnd) {
      const state = stack.pop();
      if (state) {
        alpha = state.alpha;
        transform = state.transform;
      }
    } else if (op === ops.transform) transform = multiply(transform, args);
    else if (op === ops.setGState)
      for (const [name, value] of args[0]) if (name === 'ca') alpha = value;
    const image = imageNames.some((name) => ops[name] === op);
    let identity: string | undefined;
    let bitmap: ReturnType<typeof imageSignature> | undefined;
    let bitmapKey: string | undefined;
    if (image && typeof args[0] === 'string') {
      const pool = args[0].startsWith('g_') ? page.commonObjs : page.objs;
      const object = pool?.has(args[0]) ? pool.get(args[0]) : undefined;
      if (object?.data) {
        bitmap = imageSignature(object);
        identity = bitmap.hash;
        bitmapKey = `bitmap:${object.width}x${object.height}:${identity}`;
      }
      // 无法确认图像内容相同时，不仅凭尺寸和透明度忽略它。
      identity ||= args[0];
    }
    const data = image ? [identity, ...args.slice(1)] : args;
    return {
      alpha,
      bitmap,
      bitmapKey,
      key: createHash('sha256')
        .update(JSON.stringify([op, data, transform, alpha]))
        .digest('hex'),
    };
  });
}

async function repeatedOperations(document: any, ops: any): Promise<Set<string>> {
  if (document.numPages < 3) return new Set();
  let pending = decorationCache.get(document);
  if (!pending) {
    pending = (async () => {
      const counts = new Map<string, number>();
      for (let n = 1; n <= Math.min(5, document.numPages); n++) {
        const page = await document.getPage(n),
          list = await page.getOperatorList();
        const keys = new Set<string>(
          (await operationInfo(list, ops, page))
            .filter(
              (_: any, i: number) =>
                list.fnArray[i] === ops.constructPath ||
                imageNames.some((name) => ops[name] === list.fnArray[i]),
            )
            .flatMap((r) => r.bitmapKey ? [r.key, r.bitmapKey] : [r.key]),
        );
        for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
      }
      return new Set([...counts].filter(([, count]) => count >= 3).map(([key]) => key));
    })();
    decorationCache.set(document, pending);
  }
  return pending;
}

export function textPositions(
  content: any,
  viewport: any,
  options: { fontMetrics?: boolean } = {},
): TextPosition[] {
  return content.items
    .filter((i: any) => typeof i.str === 'string')
    .map((item: any, index: number) => {
      const [a, b, c, d, e, f] = viewport.transform;
      const x = item.transform[4],
        y = item.transform[5];
      // Layout coverage thresholds use the original full-em boxes. Font metrics
      // are opt-in for source highlighting and must not change recognition routing.
      const style = options.fontMetrics ? content.styles?.[item.fontName] : undefined;
      const vertical = style?.vertical === true;
      // PDF.js TextLayer rotates vertical fonts by +π/2 in DOM coordinates.
      // In PDF coordinates that is -π/2, with geom.height as the run advance;
      // the font size still comes from the transform, not the entire run length.
      const angle = Math.atan2(item.transform[1], item.transform[0]) - (vertical ? Math.PI / 2 : 0);
      const w = vertical ? Math.abs(item.height || 0) : item.width || 0;
      const h = vertical
        ? Math.hypot(item.transform[2], item.transform[3])
        : Math.abs(item.height || 10);
      const ascent = Number.isFinite(style?.ascent) ? style.ascent : 1;
      const descent = Number.isFinite(style?.descent) ? style.descent : 0;
      const lower = h * descent,
        upper = h * ascent;
      const corners = [
        [x - lower * Math.sin(angle), y + lower * Math.cos(angle)],
        [
          x + w * Math.cos(angle) - lower * Math.sin(angle),
          y + w * Math.sin(angle) + lower * Math.cos(angle),
        ],
        [x - upper * Math.sin(angle), y + upper * Math.cos(angle)],
        [
          x + w * Math.cos(angle) - upper * Math.sin(angle),
          y + w * Math.sin(angle) + upper * Math.cos(angle),
        ],
      ];
      const points = corners.map(([px, py]) => [
        (a * px + c * py + e) / viewport.width,
        (b * px + d * py + f) / viewport.height,
      ]);
      return {
        text: item.str,
        index,
        bbox: clamp([
          Math.min(...points.map((p) => p[0])),
          Math.min(...points.map((p) => p[1])),
          Math.max(...points.map((p) => p[0])),
          Math.max(...points.map((p) => p[1])),
        ]),
      };
    });
}

/** 全在本地执行；纯文字不渲染。边界记录使用当前锁定的 PDF.js 6.4 API。 */
export async function locateRegions(
  document: any,
  page: any,
  native: string,
  content: any,
): Promise<PdfRegion[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const ops = pdfjs.OPS as any;
  const list = await page.getOperatorList();
  const images = new Set(imageNames.map((n) => ops[n]));
  const graphics = new Set([...images, ops.constructPath, ops.shadingFill]);
  const hasGraphics = hasPdfGraphics(list, ops);
  const corrupt =
    /\uFFFD/.test(native) ||
    (native.length > 20 && (native.match(/[\x00-\x08]/g)?.length || 0) > native.length / 10);
  const viewport = page.getViewport({ scale: 1 });
  const texts = textPositions(content, viewport);
  const full = (kind: 'scan' | 'fallback', reason: string): PdfRegion[] => [
    {
      kind,
      reason,
      bbox: [0, 0, 1, 1],
      context: native.slice(0, 6000),
      textIndexes: texts.map((t) => t.index),
    },
  ];
  if (corrupt) return full('fallback', '原生文字层乱码');
  if (!hasGraphics) return [];
  const repeated = await repeatedOperations(document, ops);
  const info = await operationInfo(list, ops, page);
  // 低分辨率只用于记录绘制后的真实边界，支持剪裁、变换、旋转和 Form XObject。
  const scale = Math.min(1, 1200 / Math.max(viewport.width, viewport.height));
  const view = page.getViewport({ scale });
  const canvas = document.canvasFactory.create(Math.ceil(view.width), Math.ceil(view.height));
  try {
    await page.render({
      canvas: canvas.canvas,
      canvasContext: canvas.context,
      viewport: view,
      recordOperations: true,
      recordImages: true,
    }).promise;
  } finally {
    document.canvasFactory.destroy(canvas);
  }
  const reader = page.recordedBBoxes;
  if (!reader) return full('fallback', '绘图边界不可用');
  const candidates: { bbox: RegionBox; image: boolean; rasterOnly: boolean; count: number; scaleLimit?: number }[] = [];
  let missing = false;
  for (let i = 0; i < list.fnArray.length; i++) {
    const op = list.fnArray[i];
    if (!graphics.has(op) || (op === ops.constructPath && list.argsArray[i]?.[0] === ops.endPath))
      continue;
    const { bitmap, bitmapKey } = info[i];
    const recurringBitmap = native.trim().length >= 16 && bitmap && bitmapKey && repeated.has(bitmapKey);
    // Watermark opacity can be baked into RGBA rather than set in the PDF graphics state.
    if (recurringBitmap && bitmap.maxAlpha * info[i].alpha <= 0.25) continue;
    if (reader.isEmpty(i)) {
      if (images.has(op) || op === ops.shadingFill) missing = true;
      continue;
    }
    const bbox = clamp([reader.minX(i), reader.minY(i), reader.maxX(i), reader.maxY(i)]);
    if (!bbox.every(Number.isFinite)) {
      missing = true;
      continue;
    }
    const width = bbox[2] - bbox[0],
      height = bbox[3] - bbox[1];
    const image = images.has(op);
    if (recurringBitmap && repeated.has(info[i].key) && bitmap.meanAlpha <= 0.25 &&
        height <= 0.09 && (bbox[1] >= 0.9 || bbox[3] <= 0.1)) continue;
    if (
      repeated.has(info[i].key) &&
      (info[i].alpha <= 0.25 ||
        (!image &&
          (bbox[2] < 0.16 || bbox[3] < 0.12 || bbox[1] > 0.94 || (width > 0.8 && height < 0.02))))
    )
      continue;
    if (image && area(bbox) > 0.78) {
      // 可用 OCR 层保留；整页扫描图仍作为一个识别输入，不逐字重做原生正文。
      return full('scan', native.trim() ? '整页扫描图含文字层' : '整页扫描图');
    }
    if (!image && width > 0.94 && height > 0.94) continue; // 页背景/边框
    if (area(bbox) < 0.00003 && !image) continue;
    if (image && (width < 0.025 || height < 0.015)) continue; // 极小装饰
    const args = list.argsArray[i];
    const scaleLimit =
      op === ops.paintImageXObject && args[1] > 0 && args[2] > 0
        ? Math.min(2, args[1] / (width * viewport.width), args[2] / (height * viewport.height))
        : undefined;
    candidates.push({ bbox, image, rasterOnly: image, count: 1, scaleLimit });
  }
  if (missing) return full('fallback', '图片或渐变区域无法可靠定位');
  // 合并相交/相邻的绘图构件，箭头、节点与表格线共同形成一个区域。
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < candidates.length; i++)
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i].bbox,
          b = candidates[j].bbox;
        const horizontalOverlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        const sameChart =
          horizontalOverlap > 0.6 * Math.max(a[2] - a[0], b[2] - b[0]) && near(a, b, 0.06);
        if (!near(a, b, 0.025) && !sameChart) continue;
        candidates[i] = {
          bbox: union(candidates[i].bbox, candidates[j].bbox),
          image: candidates[i].image || candidates[j].image,
          rasterOnly: candidates[i].rasterOnly && candidates[j].rasterOnly,
          count: candidates[i].count + candidates[j].count,
        };
        candidates.splice(j, 1);
        changed = true;
        break outer;
      }
  }
  const result: PdfRegion[] = [];
  for (const candidate of candidates) {
    const b = candidate.bbox;
    // 单根横线/竖线通常是装饰；成组线条保留为表格/图表。
    if (!candidate.image && candidate.count === 1 && (b[2] - b[0] < 0.012 || b[3] - b[1] < 0.012))
      continue;
    if (!candidate.image && area(b) < 0.0005) continue;
    let bbox = clamp([b[0] - 0.015, b[1] - 0.015, b[2] + 0.015, b[3] + 0.015]);
    const labelBounds = [...bbox] as RegionBox;
    // 只吸收同一水平区域内的标注和紧邻图注，避免跨栏扩张。
    for (const text of texts) {
      if (!text.text.trim()) continue;
      const t = text.bbox;
      const overlap = Math.min(labelBounds[2], t[2]) - Math.max(labelBounds[0], t[0]);
      const sideLabel =
        t[2] - t[0] < 0.18 &&
        Math.min(labelBounds[3], t[3]) > Math.max(labelBounds[1], t[1]) &&
        near(labelBounds, t, 0.025);
      const stackedLabel =
        t[2] - t[0] < 0.3 &&
        overlap > 0.5 * Math.max(0.001, t[2] - t[0]) &&
        near(labelBounds, t, 0.06);
      if (
        (overlap > 0 &&
          overlap / Math.max(0.001, t[2] - t[0]) > 0.5 &&
          near(labelBounds, t, 0.018)) ||
        sideLabel ||
        stackedLabel
      )
        bbox = union(bbox, t);
    }
    bbox = clamp([bbox[0] - 0.005, bbox[1] - 0.005, bbox[2] + 0.005, bbox[3] + 0.005]);
    if (area(bbox) > 0.85) return full('fallback', '图形区域覆盖整页，无法安全分离');
    const nearby = texts.filter((t) => {
      if (!t.text.trim()) return false;
      const overlap = Math.min(bbox[2], t.bbox[2]) - Math.max(bbox[0], t.bbox[0]);
      return (
        overlap > 0 &&
        overlap / Math.max(0.001, t.bbox[2] - t.bbox[0]) >= 0.5 &&
        t.bbox[1] <= bbox[3] + 0.12 &&
        t.bbox[3] >= bbox[1] - 0.12
      );
    });
    result.push({
      inkBox: b,
      bbox,
      kind: 'region',
      scaleLimit: candidate.scaleLimit,
      rasterOnly: candidate.rasterOnly,
      context: nearby
        .map((t) => t.text)
        .join('\n')
        .slice(0, 4000),
      textIndexes: nearby.map((t) => t.index),
    });
  }
  return result.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}
