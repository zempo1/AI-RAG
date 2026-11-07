import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParseContext } from './pdf-visual.service';
import type { RegionBox } from './parsed-document';
import {
  hasPdfGraphics,
  locateRegions,
  PdfRegion,
  textPositions,
  TextPosition,
} from './pdf-layout';
import {
  PdfAnalysisClient,
  LayoutRegion,
  LayoutResult,
  validateLayout,
} from './pdf-analysis.client';
import { localRendering } from './vision-scheduler';
import { discardPdfPageRaster } from './pdf-render-cache';

export interface HybridPdfRegion extends PdfRegion {
  recognition: 'ocr' | 'vision';
  analysisProfile: string;
  /** Expected text geometry in normalized page coordinates, before crop padding. */
  ocrExpectedBoxes?: RegionBox[];
}
const VERSION = 'hybrid-layout-v5-native-regions';
const NATIVE_REGION_VERSION = 'native-regions-v2-outside-prose-bounded-paint';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const area = (b: RegionBox) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const intersection = (a: RegionBox, b: RegionBox) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const covered = (a: RegionBox, b: RegionBox) => intersection(a, b) / Math.max(1e-9, area(a));
const union = (a: RegionBox, b: RegionBox): RegionBox => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const pad = (b: RegionBox, p: number): RegionBox => [
  Math.max(0, b[0] - p),
  Math.max(0, b[1] - p),
  Math.min(1, b[2] + p),
  Math.min(1, b[3] + p),
];
const readable = (s: string) => s.trim().length > 0 && !/[\uFFFD\x00-\x08]/.test(s);
const textKind = (r: LayoutRegion) => ['text', 'title', 'caption'].includes(r.kind);
const visualKind = (r: LayoutRegion) => ['figure', 'table', 'unknown'].includes(r.kind);

async function check(scope: ParseContext) {
  scope.signal?.throwIfAborted();
  await scope.guard?.();
  scope.signal?.throwIfAborted();
}

/** Require several aligned rows and distinct columns; prose line starts alone are not a table. */
function tableSuspicion(texts: TextPosition[]) {
  const rows: TextPosition[][] = [];
  for (const t of texts.filter((t) => t.text.trim())) {
    let row = rows.find((r) => Math.abs(r[0].bbox[1] - t.bbox[1]) < 0.008);
    if (!row) rows.push((row = []));
    row.push(t);
  }
  const aligned = rows
    .filter((r) => r.length >= 2)
    .map((r) =>
      r
        .sort((a, b) => a.bbox[0] - b.bbox[0])
        .filter((t, i) => !i || t.bbox[0] - r[i - 1].bbox[2] > 0.025),
    )
    .filter((r) => r.length >= 2);
  for (const row of aligned) {
    const columns = row;
    if (
      aligned.filter(
        (r) =>
          columns.filter((c) => r.some((t) => Math.abs(t.bbox[0] - c.bbox[0]) < 0.012)).length >= 2,
      ).length >= 2
    )
      return true;
  }
  return false;
}

function nativeCovers(box: RegionBox, texts: TextPosition[], native: string) {
  if (!readable(native)) return false;
  const inside = texts.filter((t) => readable(t.text) && covered(t.bbox, box) > 0.75);
  if (
    inside
      .map((t) => t.text)
      .join('')
      .replace(/\s/g, '').length === 0
  )
    return false;
  const bounds = inside.map((t) => t.bbox).reduce(union);
  const height = Math.max(...inside.map((t) => t.bbox[3] - t.bbox[1]));
  const heights = inside.map((t) => t.bbox[3] - t.bbox[1]).sort((a, b) => a - b);
  const lineHeight = heights[Math.floor(heights.length / 2)];
  const ordered = inside.map((t) => t.bbox).sort((a, b) => a[1] - b[1]);
  let end = ordered[0][3];
  for (const row of ordered.slice(1)) {
    // A hull spanning the first and last recovered line must not conceal a
    // missing paragraph. Normal interline whitespace remains acceptable.
    if (row[1] - end > lineHeight * 2.5) return false;
    end = Math.max(end, row[3]);
  }
  return (
    bounds[2] - bounds[0] >= (box[2] - box[0]) * 0.6 &&
    (bounds[3] - bounds[1] >= (box[3] - box[1]) * 0.6 || box[3] - box[1] <= height * 1.6)
  );
}

function explained(
  candidate: PdfRegion,
  model: LayoutRegion[],
  texts: TextPosition[],
  native: string,
) {
  // Legacy boxes include 2% safety padding; compare with the actual ink bounds.
  const ink = candidate.inkBox || pad(candidate.bbox, -0.02);
  if (model.some((r) => visualKind(r) && intersection(ink, r.bbox) > 0)) return false;
  return model.some(
    (r) =>
      r.score >= (r.kind === 'title' ? 0.5 : 0.85) &&
      covered(ink, pad(r.bbox, 0.008)) >= 0.85 &&
      (r.kind === 'decoration' || (textKind(r) && nativeCovers(r.bbox, texts, native))),
  );
}

/** Native extraction and painted geometry jointly justify bypassing local ML.
 * A readable header alone cannot establish that the rest of the page is native.
 */
function nativeRegionsReady(
  list: any,
  ops: any,
  native: string,
  texts: TextPosition[],
  legacy: PdfRegion[],
) {
  if (!readable(native) || !legacy.length) return false;
  const raster = new Set([
    ...[
      'paintImageXObject',
      'paintInlineImageXObject',
      'paintImageXObjectRepeat',
      'paintImageMaskXObject',
      'paintImageMaskXObjectRepeat',
      'paintImageMaskXObjectGroup',
      'paintInlineImageXObjectGroup',
    ].map((name) => ops[name]),
  ]);
  if (list.fnArray.some((op: number) => op === ops.shadingFill)) return false;
  if (
    legacy.some(
      (r) =>
        r.kind !== 'region' ||
        !r.inkBox ||
        area(r.inkBox) <= 0 ||
        area(r.inkBox) > 0.45 ||
        area(r.bbox) > 0.45,
    )
  )
    return false;
  if (legacy.reduce((sum, r) => sum + area(r.inkBox!), 0) > 0.65) return false;
  const nonempty = texts.filter((t) => t.text.trim());
  const valid = nonempty.filter(
    (t) =>
      readable(t.text) &&
      t.bbox.every(Number.isFinite) &&
      area(t.bbox) > 0 &&
      t.bbox[3] - t.bbox[1] < 0.25,
  );
  const letters = valid
    .map((t) => t.text)
    .join('')
    .replace(/\s/g, '');
  if (
    letters.length < 16 ||
    valid.length < nonempty.length * 0.95 ||
    (letters.match(/[\p{L}\p{N}]/gu)?.length || 0) < letters.length * 0.6
  )
    return false;
  const bounds = valid.map((t) => t.bbox).reduce(union);
  const centers = valid.map((t) => (t.bbox[1] + t.bbox[3]) / 2);
  if (bounds[2] - bounds[0] < 0.12 || Math.max(...centers) - Math.min(...centers) < 0.03)
    return false;
  const outside = valid.filter(
    (t) => !legacy.some((r) => covered(t.bbox, pad(r.inkBox!, 0.005)) > 0.5),
  );
  const outsideLetters = outside
    .map((t) => t.text)
    .join('')
    .replace(/\s/g, '');
  if (list.fnArray.some((op: number) => raster.has(op))) {
    // Text recovered mainly inside an image can be a sparse OCR scan layer.
    // Require substantial, spatially separate prose outside all image/figure ink.
    const outsideCenters = outside.map((t) => (t.bbox[1] + t.bbox[3]) / 2);
    if (
      outsideLetters.length < 24 ||
      outsideLetters.length < letters.length * 0.5 ||
      Math.max(...outsideCenters) - Math.min(...outsideCenters) < 0.03
    )
      return false;
  }
  // An unrelated small figure does not locate a separate borderless native table.
  return !tableSuspicion(valid.filter((t) => !legacy.some((r) => covered(t.bbox, r.bbox) > 0.75)));
}

async function render(document: any, page: any, size: number, scope: ParseContext) {
  await check(scope);
  return localRendering.run(async () => {
    await check(scope);
    discardPdfPageRaster();
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: size / Math.max(base.width, base.height) });
    const canvas = document.canvasFactory.create(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    try {
      await page.render({ canvas: canvas.canvas, canvasContext: canvas.context, viewport }).promise;
      await check(scope);
      return canvas.canvas.toBuffer('image/png') as Buffer;
    } finally {
      document.canvasFactory.destroy(canvas);
    }
  }, scope.signal);
}

interface CachedLayout extends LayoutResult {
  high: boolean;
}
async function layout(
  document: any,
  page: any,
  scope: ParseContext,
  client: PdfAnalysisClient,
  needsHigh: (regions: LayoutRegion[]) => boolean,
): Promise<CachedLayout> {
  await check(scope);
  scope.beforeRequest?.();
  // Explicit health refresh is intentional: a process restart can replace the model behind the same URL.
  const health = await client.health(scope.signal);
  await check(scope);
  const bytes = await render(document, page, 1280, scope);
  const imageHash = hash(bytes);
  const directory = client.cacheDirectory(scope);
  const file = (manifest: string) =>
    directory &&
    join(
      directory,
      `${page.pageNumber}-${hash(JSON.stringify({ imageHash, manifest, version: VERSION }))}.json`,
    );
  let cached: CachedLayout | undefined;
  const source = file(health.manifest);
  if (source) {
    try {
      const raw = JSON.parse(await readFile(source, 'utf8'));
      const valid = validateLayout(raw);
      if (
        raw.imageHash === imageHash &&
        valid.manifest === health.manifest &&
        typeof raw.high === 'boolean'
      )
        cached = { ...valid, high: raw.high };
    } catch (error: any) {
      if (error.code && error.code !== 'ENOENT') throw error;
      // Invalid or interrupted metadata is a cache miss; service errors are never caught here.
    }
    await check(scope);
  }
  if (cached && (cached.high || !needsHigh(cached.regions))) return cached;
  scope.beforeRequest?.();
  const standard = cached || (await client.layout(bytes, 'standard', scope.signal));
  await check(scope);
  let result: CachedLayout = { ...standard, high: false };
  if (needsHigh(standard.regions)) {
    const high = await render(document, page, 2560, scope);
    await check(scope);
    scope.beforeRequest?.();
    result = { ...(await client.layout(high, 'high', scope.signal)), high: true };
    await check(scope);
  }
  const target = file(result.manifest);
  if (directory && target) {
    await check(scope);
    await mkdir(directory, { recursive: true });
    const temp = target + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify({ ...result, imageHash }));
    await check(scope);
    await rename(temp, target);
    await check(scope);
  }
  return result;
}

/** Model semantics select recognition work; PDF.js geometry only supplements visual boundaries. */
export async function locateHybridRegions(
  document: any,
  page: any,
  native: string,
  content: any,
  scope: ParseContext,
  client: PdfAnalysisClient,
): Promise<HybridPdfRegion[]> {
  await check(scope);
  const viewport = page.getViewport({ scale: 1 });
  const texts = textPositions(content, viewport);
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const ops: any = OPS;
  const list: any = await localRendering.run(() => page.getOperatorList(), scope.signal);
  const hasGraphics = hasPdfGraphics(list, ops);
  const textPaint = new Set(
    ['showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText'].map(
      (k) => ops[k],
    ),
  );
  if (!native.trim() && !hasGraphics && !list.fnArray.some((op: number) => textPaint.has(op))) {
    await check(scope);
    return [];
  }
  if (readable(native) && !hasGraphics && !tableSuspicion(texts)) {
    await check(scope);
    return [];
  }
  // This lock ends before model rendering starts. locateRegions itself must never run under a nested lock.
  const legacy = hasGraphics
    ? await localRendering.run(async () => {
        discardPdfPageRaster();
        return locateRegions(document, page, native, content);
      }, scope.signal)
    : [];
  await check(scope);
  if (readable(native) && !legacy.length && !tableSuspicion(texts)) return [];
  const needsHigh = (model: LayoutRegion[]) =>
    model.some(
      (r) =>
        r.kind === 'unknown' ||
        (r.score < 0.75 && !(textKind(r) && nativeCovers(r.bbox, texts, native))),
    ) ||
    legacy.some(
      (r) =>
        r.kind === 'region' &&
        !explained(r, model, texts, native) &&
        !model.some((m) => visualKind(m) && covered(r.bbox, pad(m.bbox, 0.02)) > 0.6),
    ) ||
    (!model.some((r) => r.kind !== 'decoration') &&
      (!readable(native) || legacy.some((r) => r.kind !== 'region')));
  const nativeFastPath =
    hasGraphics &&
    readable(native) &&
    client.config.get('PDF_ANALYSIS_NATIVE_FAST_PATH') !== false &&
    nativeRegionsReady(list, ops, native, texts, legacy);
  const result: LayoutResult = nativeFastPath
    ? {
        regions: legacy.map((r) => ({ kind: 'figure', bbox: r.inkBox!, score: 1 })),
        manifest: NATIVE_REGION_VERSION,
      }
    : await layout(document, page, scope, client, needsHigh);
  await check(scope);
  const model = result.regions;
  const profile = hash(JSON.stringify({ version: VERSION, manifest: result.manifest }));
  const seeds: HybridPdfRegion[] = [];
  const add = (bbox: RegionBox, recognition: 'ocr' | 'vision', reason?: string) => {
    seeds.push({
      bbox,
      kind: 'region',
      recognition,
      analysisProfile: profile,
      reason,
      context: '',
      textIndexes: [],
      ...(recognition === 'ocr' ? { ocrExpectedBoxes: [bbox] } : {}),
    });
  };
  for (const r of model) {
    if (visualKind(r))
      add(r.bbox, 'vision', r.kind === 'unknown' ? '高精度版面仍无法确定区域类型' : undefined);
    else if (r.kind === 'decoration' && r.score < 0.75)
      add(r.bbox, 'vision', '高精度版面仍无法可靠排除非文字内容');
    else if (
      textKind(r) &&
      !nativeCovers(r.bbox, texts, native) &&
      !model.some((v) => visualKind(v) && covered(r.bbox, v.bbox) > 0.65)
    )
      add(r.bbox, 'ocr');
  }
  for (const r of legacy.filter((r) => r.kind === 'region')) {
    if (explained(r, model, texts, native)) continue;
    const ink = pad(r.bbox, -0.02);
    // A page frame may enclose a real figure. Its presence is not evidence
    // that the figure itself occupies that frame's entire bounding rectangle.
    if (
      model.some(
        (m) =>
          m.kind === 'decoration' &&
          m.score >= 0.85 &&
          covered(ink, pad(m.bbox, 0.008)) >= 0.85 &&
          area(m.bbox) <= area(ink) * 1.5,
      )
    )
      continue;
    const supplemental = r.inkBox || r.bbox;
    const graphic = seeds.find(
      (s) =>
        s.recognition === 'vision' &&
        (covered(supplemental, pad(s.bbox, 0.02)) > 0.6 ||
          covered(s.bbox, pad(supplemental, 0.02)) > 0.6),
    );
    if (graphic) {
      graphic.bbox = union(graphic.bbox, supplemental);
      graphic.scaleLimit = r.scaleLimit;
    } else if (!explained(r, model, texts, native))
      add(r.bbox, 'vision', 'PDF 绘图候选未被版面模型解释');
  }
  // When nothing can be located, only an explicit fallback may consume a full page in vision.
  if (
    !seeds.length &&
    (!readable(native) || legacy.some((r) => r.kind !== 'region')) &&
    !model.some((r) => textKind(r) || visualKind(r)) &&
    !model.some((r) => r.kind === 'decoration' && r.score >= 0.85)
  ) {
    return [
      {
        bbox: [0, 0, 1, 1],
        kind: 'fallback',
        reason: '高精度版面无法可靠定位内容',
        context: native.slice(0, 6000),
        textIndexes: texts.map((t) => t.index),
        recognition: 'vision',
        analysisProfile: profile,
      },
    ];
  }
  for (const seed of seeds) {
    const anchor = seed.bbox;
    let bounds = anchor;
    if (seed.recognition === 'vision') {
      const nearby = [
        ...texts.filter((t) => t.text.trim()).map((t) => t.bbox),
        ...model.filter((r) => r.kind === 'caption').map((r) => r.bbox),
      ];
      for (const t of nearby) {
        const overlap = Math.min(anchor[2], t[2]) - Math.max(anchor[0], t[0]);
        const sameColumn = overlap / Math.max(0.001, t[2] - t[0]) >= 0.55;
        const close = t[1] <= anchor[3] + 0.065 && t[3] >= anchor[1] - 0.065;
        if (sameColumn && close && t[2] - t[0] <= Math.max(0.3, (anchor[2] - anchor[0]) * 1.25))
          bounds = union(bounds, t);
      }
    }
    seed.bbox = pad(bounds, 0.008);
  }
  // Expansion can make two model fragments overlap. Merge then, while requiring real horizontal overlap.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < seeds.length; i++)
      for (let j = i + 1; j < seeds.length; j++) {
        const a = seeds[i],
          b = seeds[j];
        const horizontal = Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]);
        if (
          a.recognition !== b.recognition ||
          intersection(a.bbox, b.bbox) <= 0 ||
          horizontal < 0.15 * Math.min(a.bbox[2] - a.bbox[0], b.bbox[2] - b.bbox[0])
        )
          continue;
        a.bbox = union(a.bbox, b.bbox);
        if (a.ocrExpectedBoxes) a.ocrExpectedBoxes.push(...(b.ocrExpectedBoxes || []));
        seeds.splice(j, 1);
        merged = true;
        break outer;
      }
  }
  for (const seed of seeds) {
    const nearby = texts.filter((t) => {
      const horizontal = Math.min(seed.bbox[2], t.bbox[2]) - Math.max(seed.bbox[0], t.bbox[0]);
      return (
        t.text.trim() &&
        horizontal / Math.max(0.001, t.bbox[2] - t.bbox[0]) >= 0.55 &&
        t.bbox[1] <= seed.bbox[3] + 0.12 &&
        t.bbox[3] >= seed.bbox[1] - 0.12
      );
    });
    seed.context = nearby
      .map((t) => t.text)
      .join('\n')
      .slice(0, 4000);
    seed.textIndexes = nearby.map((t) => t.index);
  }
  await check(scope);
  return seeds.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}
