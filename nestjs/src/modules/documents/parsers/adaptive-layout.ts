import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParseContext } from './pdf-visual.service';
import type { RegionBox } from './parsed-document';
import {
  groupNearbyCrops,
  hasPdfGraphics,
  locateRegions,
  PdfRegion,
  textPositions,
  TextPosition,
} from './pdf-layout';
import {
  analysisHealth,
  PdfAnalysisClient,
  LayoutRegion,
  LayoutResult,
  validateLayout,
  verifyAnalysisManifest,
} from './pdf-analysis.client';
import { localRendering } from './vision-scheduler';
import { discardPdfPageRaster, pdfRegionScale } from './pdf-render-cache';

export interface AdaptivePdfRegion extends PdfRegion {
  recognition: 'ocr' | 'vision' | 'classify';
  analysisProfile: string;
  /** Expected text geometry in normalized page coordinates, before crop padding. */
  ocrExpectedBoxes?: RegionBox[];
}
const VERSION = 'adaptive-layout-v1';
const NATIVE_REGION_VERSION = 'native-regions-v3-content-routing';
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
    .map((row) => {
      const columns: [number, number][] = [];
      for (const { bbox: [left, , right] } of row.sort((a, b) => a.bbox[0] - b.bbox[0])) {
        const previous = columns.at(-1);
        if (previous && left - previous[1] <= 0.025)
          previous[1] = Math.max(previous[1], right);
        else columns.push([left, right]);
      }
      return { top: row[0].bbox[1], columns };
    })
    // Two wide runs on the same baseline are ordinary parallel prose columns.
    .filter(({ columns }) => columns.length >= 2 &&
      !(columns.length === 2 && columns.every(([left, right]) => right - left > 0.22)));
  return aligned.some((a, i) => aligned.slice(i + 1).some((b) =>
    Math.abs(a.top - b.top) < 0.12 &&
    a.columns.filter(([left]) => b.columns.some(([other]) => Math.abs(other - left) < 0.012))
      .length >= 2,
  ));
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
  geometry: PdfRegion[],
) {
  if (!readable(native) || !geometry.length) return false;
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
    geometry.some(
      (r) =>
        r.kind !== 'region' ||
        !r.inkBox ||
        area(r.inkBox) <= 0 ||
        area(r.inkBox) > 0.45 ||
        area(r.bbox) > 0.45,
    )
  )
    return false;
  if (geometry.reduce((sum, r) => sum + area(r.inkBox!), 0) > 0.65) return false;
  const hasRaster = list.fnArray.some((op: number) => raster.has(op));
  const outsideGraphics = texts.filter((t) => !geometry.some((r) => covered(t.bbox, r.bbox) > 0.75));
  if (!hasRaster) {
    const possibleOutlinedText = geometry.some((r) =>
      texts.some((t) => readable(t.text) && covered(r.inkBox!, pad(t.bbox, 0.008)) > 0.5),
    );
    return !possibleOutlinedText && !tableSuspicion(outsideGraphics);
  }
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
    (t) => !geometry.some((r) => covered(t.bbox, pad(r.inkBox!, 0.005)) > 0.5),
  );
  const outsideLetters = outside
    .map((t) => t.text)
    .join('')
    .replace(/\s/g, '');
  // Text recovered mainly inside an image can be a sparse OCR scan layer.
  const outsideCenters = outside.map((t) => (t.bbox[1] + t.bbox[3]) / 2);
  if (
    outsideLetters.length < 24 ||
    outsideLetters.length < letters.length * 0.5 ||
    Math.max(...outsideCenters) - Math.min(...outsideCenters) < 0.03
  )
    return false;
  // An unrelated small figure does not locate a separate borderless native table.
  return !tableSuspicion(outsideGraphics);
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

async function layout(
  document: any,
  page: any,
  scope: ParseContext,
  client: PdfAnalysisClient,
): Promise<LayoutResult> {
  await check(scope);
  scope.beforeRequest?.();
  const health = await analysisHealth(client, scope);
  await check(scope);
  const directory = client.cacheDirectory(scope);
  // A streaming caller supplies the immutable source identity. Standalone callers
  // without it can still safely cache after checking the actual raster.
  let bytes = scope.sourceHash ? undefined : await render(document, page, 1280, scope);
  const key = hash(JSON.stringify({
    source: scope.sourceHash || hash(bytes!),
    manifest: health.manifest,
    version: VERSION,
  }));
  const target = directory && join(directory, `${page.pageNumber}-${key}.json`);
  let hit: LayoutResult | undefined;
  if (target) {
    try {
      const raw = JSON.parse(await readFile(target, 'utf8'));
      const valid = validateLayout(raw);
      if (raw.key === key && valid.manifest === health.manifest) hit = valid;
    } catch (error: any) {
      if (error.code && error.code !== 'ENOENT') throw error;
      scope.signal?.throwIfAborted();
    }
    await check(scope);
  }
  await check(scope);
  if (hit) return hit;
  scope.beforeRequest?.();
  bytes ||= await render(document, page, 1280, scope);
  const result = await client.layout(bytes, scope.signal);
  verifyAnalysisManifest(result, health.manifest);
  await check(scope);
  if (directory && target) {
    await check(scope);
    await mkdir(directory, { recursive: true });
    const temp = target + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify({ ...result, key }));
    await check(scope);
    await rename(temp, target);
    await check(scope);
  }
  return result;
}

/** Model semantics select recognition work; PDF.js geometry only supplements visual boundaries. */
export async function locateAdaptiveRegions(
  document: any,
  page: any,
  native: string,
  content: any,
  scope: ParseContext,
  client: PdfAnalysisClient,
): Promise<AdaptivePdfRegion[]> {
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
  const geometry = hasGraphics
    ? await localRendering.run(async () => {
        discardPdfPageRaster();
        return locateRegions(document, page, native, content);
      }, scope.signal)
    : [];
  await check(scope);
  if (readable(native) && !geometry.length && !tableSuspicion(texts)) return [];
  if (nativeRegionsReady(list, ops, native, texts, geometry)) {
    return groupNearbyCrops(geometry, ([x0, y0, x1, y1], limit) =>
      pdfRegionScale(viewport.width * (x1 - x0), viewport.height * (y1 - y0), limit),
    ).map((region) => ({
      ...region,
      recognition: region.rasterOnly ? 'classify' : 'vision',
      analysisProfile: NATIVE_REGION_VERSION,
    }));
  }
  const result = await layout(document, page, scope, client);
  await check(scope);
  const model = result.regions;
  const profile = hash(JSON.stringify({ version: VERSION, manifest: result.manifest }));
  const seeds: AdaptivePdfRegion[] = [];
  const add = (bbox: RegionBox, recognition: AdaptivePdfRegion['recognition'], reason?: string) => {
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
    if (visualKind(r)) {
      const raster = r.kind === 'figure' &&
        geometry.some((candidate) => candidate.rasterOnly && covered(r.bbox, candidate.bbox) > 0.8);
      add(r.bbox, raster ? 'classify' : 'vision',
        r.kind === 'unknown' ? '版面检测无法确定区域类型' : undefined);
    }
    else if (r.kind === 'decoration' && r.score < 0.75) {
      const margin = r.bbox[3] <= 0.17 || r.bbox[1] >= 0.88;
      if (!(margin && readable(native) && !geometry.some((g) => intersection(g.bbox, r.bbox) > 0)))
        add(r.bbox, 'vision', '版面检测无法可靠排除非文字内容');
    }
    else if (
      textKind(r) &&
      !nativeCovers(r.bbox, texts, native) &&
      !model.some((v) => visualKind(v) && covered(r.bbox, v.bbox) > 0.65)
    )
      add(r.bbox, r.score >= 0.75 ? 'ocr' : 'classify');
  }
  for (const r of geometry.filter((r) => r.kind === 'region')) {
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
        s.recognition !== 'ocr' &&
        (covered(supplemental, pad(s.bbox, 0.02)) > 0.6 ||
          covered(s.bbox, pad(supplemental, 0.02)) > 0.6),
    );
    if (graphic) {
      graphic.bbox = union(graphic.bbox, supplemental);
      graphic.scaleLimit = r.scaleLimit;
    } else if (!explained(r, model, texts, native))
      add(r.bbox, r.rasterOnly ? 'classify' : 'vision', 'PDF 绘图候选未被版面模型解释');
  }
  const scan = geometry.find((r) => r.kind === 'scan');
  if (!seeds.length && scan && !nativeCovers(scan.bbox, texts, native))
    return [{
      ...scan,
      recognition: 'classify',
      reason: '版面未覆盖扫描正文，检查整张扫描图',
      analysisProfile: profile,
    }];
  // When nothing can be located, only an explicit fallback may consume a full page in vision.
  if (
    !seeds.length &&
    (!readable(native) || geometry.some((r) => r.kind !== 'region')) &&
    !model.some((r) => textKind(r) || visualKind(r)) &&
    !model.some((r) => r.kind === 'decoration' && r.score >= 0.85)
  ) {
    return [
      {
        bbox: [0, 0, 1, 1],
        kind: 'fallback',
        reason: '版面检测无法可靠定位内容',
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
    if (seed.recognition !== 'ocr') {
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
    if (area(seed.bbox) > 0.85) {
      if (seed.recognition === 'ocr' && geometry.some((r) => r.kind === 'scan'))
        seed.kind = 'scan';
      if (seed.recognition === 'vision') {
        seed.kind = 'fallback';
        seed.reason ||= '版面识别区域接近整页，无法可靠分离';
      }
    }
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
