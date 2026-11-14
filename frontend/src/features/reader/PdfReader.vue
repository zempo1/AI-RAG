<template>
  <div class="pdf-reader">
    <div class="pdf-toolbar" aria-label="PDF 工具栏">
      <div class="pdf-tool-group">
        <button type="button" class="pdf-icon-button" aria-label="上一页" :disabled="!ready || pageNumber <= 1" @click="goToPage(pageNumber - 1)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button>
        <label class="pdf-page-control">页码
          <input aria-label="页码" type="number" min="1" :max="pageCount || 1" :value="pageNumber" :disabled="!ready" @change="pageInput" />
        </label><span>/ {{ pageCount || '—' }}</span>
        <button type="button" class="pdf-icon-button" aria-label="下一页" :disabled="!ready || pageNumber >= pageCount" @click="goToPage(pageNumber + 1)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button>
      </div>
      <div class="pdf-tool-group">
        <button type="button" class="pdf-icon-button" aria-label="缩小" :disabled="!ready" @click="zoom(1 / 1.2)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg></button>
        <output class="pdf-scale" aria-label="缩放比例">{{ scalePercent }}%</output>
        <button type="button" class="pdf-icon-button" aria-label="放大" :disabled="!ready" @click="zoom(1.2)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14" /></svg></button>
        <button type="button" :disabled="!ready" @click="fitWidth">适宽</button>
        <button type="button" aria-label="顺时针旋转 90 度" :disabled="!ready" @click="rotate">旋转</button>
      </div>
      <form class="pdf-search" role="search" @submit.prevent="find(true)">
        <input v-model="query" aria-label="搜索 PDF 文字" placeholder="搜索 PDF 文字" :disabled="!ready" @input="find(false)" />
        <button type="button" class="pdf-icon-button" aria-label="上一个匹配" :disabled="!query || !ready" @click="find(true, true)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 10 6-6 6 6M12 4v16" /></svg></button>
        <button type="submit" class="pdf-icon-button" aria-label="下一个匹配" :disabled="!query || !ready"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6 6 6-6M12 4v16" /></svg></button>
        <span class="pdf-find-status" role="status">{{ findStatus }}</span>
      </form>
    </div>
    <div v-if="loading" class="pdf-state" role="status">正在加载 PDF…{{ progress ? ` ${progress}%` : '' }}</div>
    <div v-if="error" class="pdf-state pdf-error" role="alert">
      <p>{{ error }}</p><button type="button" @click="retry">重试读取原件</button>
    </div>
    <p v-if="locationNotice && ready" class="pdf-location-notice" role="status">{{ locationNotice }}</p>
    <div class="pdf-reading-area" :class="{ 'is-loading': loading, 'has-error': !!error }">
      <div ref="container" class="pdf-scroll-container" tabindex="0" aria-label="PDF 页面，可选择复制文字">
        <div ref="pagesElement" class="pdfViewer"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getDocument, GlobalWorkerOptions, AnnotationEditorType, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { EventBus, PDFViewer, PDFLinkService, PDFFindController } from 'pdfjs-dist/web/pdf_viewer.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { Citation } from '../../api/knowledge-bases';
import { getAuthHeaders, handleUnauthorized } from '../../utils/request';
import { transformAnchorRect, type NormalizedRect } from './pdf-anchors';

GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps<{ url: string; citation?: Citation }>();
const emit = defineEmits<{ (e: 'unavailable', value: boolean): void }>();
const container = ref<HTMLDivElement>(), pagesElement = ref<HTMLDivElement>();
const loading = ref(true), ready = ref(false), error = ref(''), progress = ref(0);
const pageNumber = ref(1), pageCount = ref(0), scalePercent = ref(100), query = ref(''), findStatus = ref('');
let eventBus: EventBus | undefined, viewer: PDFViewer | undefined, links: PDFLinkService | undefined;
let findController: PDFFindController | undefined, loadingTask: PDFDocumentLoadingTask | undefined, document: PDFDocumentProxy | undefined;
let lifecycle: AbortController | undefined, resizeObserver: ResizeObserver | undefined;
let generation = 0, navigation = 0, fitting = true, pendingScroll = false;
let loadSequence = 0, disposed = false;
const citationPages = new Map<number, PDFPageProxy>();
// 资源由 Vite 构建到同域 /pdfjs/；所有字体、字符映射、WASM 均不访问 CDN。
const assetsUrl = `${import.meta.env.BASE_URL}pdfjs/`;
const targetPage = computed(() => props.citation?.location?.anchors?.[0]?.page || props.citation?.location?.regionImage?.page || props.citation?.location?.page);
const locationNotice = computed(() => {
  const citation = props.citation;
  if (!citation) return '';
  if (!targetPage.value) return '此引用位置未知，请结合下方保存的原文快照核对。';
  if (!citation.location?.anchors?.length && !citation.location?.regionImage)
    return '此历史引用缺少精准位置，已跳转到对应页面。';
  return '';
});
function goToPage(page: number) {
  if (!viewer || !ready.value) return;
  viewer.currentPageNumber = Math.min(pageCount.value, Math.max(1, Math.round(page)));
}
function pageInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  goToPage(Number.isFinite(value) ? value : 1);
  input.value = String(viewer?.currentPageNumber || pageNumber.value);
}
function fitWidth() { if (viewer && ready.value) { fitting = true; viewer.currentScaleValue = 'page-width'; } }
function zoom(factor: number) { if (viewer && ready.value) { fitting = false; viewer.currentScale = Math.min(5, Math.max(.25, viewer.currentScale * factor)); } }
function rotate() {
  if (!viewer || !ready.value) return;
  viewer.pagesRotation = (viewer.pagesRotation + 90) % 360;
  if (fitting) viewer.currentScaleValue = 'page-width';
  paintHighlights();
}
function find(again: boolean, previous = false) {
  eventBus?.dispatch('find', { source: container.value, type: again ? 'again' : '', query: query.value,
    phraseSearch: true, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  if (!query.value) findStatus.value = '';
}
function rectangles() {
  const location = props.citation?.location;
  if (location?.anchorVersion === 1 && location.anchors?.length)
    return location.anchors.flatMap(anchor => anchor.rects.map(rect => ({ page: anchor.page, rect })));
  if (location?.regionImage) return [{ page: location.regionImage.page, rect: location.regionImage.bbox }];
  return [] as {page: number; rect: NormalizedRect}[];
}
function clearHighlights() { pagesElement.value?.querySelectorAll('.citation-highlights').forEach(el => el.remove()); }
function paintHighlights() {
  if (!viewer || !ready.value) return;
  clearHighlights();
  let first: HTMLElement | undefined;
  for (const { page, rect } of rectangles()) {
    const view = viewer.getPageView(page - 1), pdfPage = citationPages.get(page);
    if (!view?.pdfPage || !pdfPage || !view.canvas || view.renderingState !== 3) continue;
    const transformed = transformAnchorRect(rect, pdfPage.getViewport({ scale: 1, rotation: pdfPage.rotate }), view.viewport);
    if (!transformed) continue;
    let overlay = view.div.querySelector('.citation-highlights') as HTMLDivElement | null;
    if (!overlay) {
      overlay = window.document.createElement('div'); overlay.className = 'citation-highlights'; overlay.setAttribute('aria-hidden', 'true');
      view.div.append(overlay);
    }
    const highlight = window.document.createElement('span'); highlight.className = 'citation-highlight';
    Object.assign(highlight.style, { left: `${transformed.left}px`, top: `${transformed.top}px`, width: `${transformed.width}px`, height: `${transformed.height}px` });
    overlay.append(highlight);
    if (page === targetPage.value) first ||= highlight;
  }
  if (pendingScroll && first) {
    pendingScroll = false;
    first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  }
}
async function navigateCitation() {
  const current = ++navigation, currentDocument = document;
  clearHighlights();
  pendingScroll = false;
  if (!ready.value || !viewer || !currentDocument || !targetPage.value) return;
  const page = Math.min(pageCount.value, Math.max(1, targetPage.value));
  const required = new Set(rectangles().map(anchor => anchor.page).filter(p => p > 0 && p <= pageCount.value));
  required.add(page);
  try {
    const pages = await Promise.all([...required].map(async number => [number, await currentDocument.getPage(number)] as const));
    if (current !== navigation || document !== currentDocument) return;
    pages.forEach(([number, proxy]) => citationPages.set(number, proxy));
    pendingScroll = rectangles().length > 0;
    viewer.scrollPageIntoView({ pageNumber: page });
    pageNumber.value = page;
    paintHighlights();
  } catch { /* 原文快照始终保留；失效任务由加载流程处理。 */ }
}
async function dispose() {
  generation++; navigation++; ready.value = false;
  resizeObserver?.disconnect(); resizeObserver = undefined;
  // 先终止事件/滚动/ResizeObserver，再取消 render 和网络任务。
  lifecycle?.abort(); lifecycle = undefined;
  viewer?.setDocument(null); links?.setDocument(null);
  viewer = undefined; eventBus = undefined; links = undefined; findController = undefined; document = undefined;
  citationPages.clear(); clearHighlights();
  const task = loadingTask; loadingTask = undefined;
  if (task) await task.destroy().catch(() => undefined);
}
async function load() {
  const request = ++loadSequence;
  await dispose();
  if (request !== loadSequence || disposed || !container.value || !pagesElement.value) return;
  const current = generation;
  loading.value = true; error.value = ''; progress.value = 0; emit('unavailable', false);
  lifecycle = new AbortController();
  const bus = eventBus = new EventBus(), signal = lifecycle.signal;
  links = new PDFLinkService({ eventBus: bus, externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer' });
  findController = new PDFFindController({ eventBus: bus, linkService: links });
  viewer = new PDFViewer({ container: container.value, viewer: pagesElement.value, eventBus: bus,
    linkService: links, findController, textLayerMode: 1, annotationEditorMode: AnnotationEditorType.DISABLE,
    removePageBorders: true, enableAutoLinking: false, abortSignal: signal } as ConstructorParameters<typeof PDFViewer>[0]);
  links.setViewer(viewer);
  bus.on('pagesinit', () => {
    if (current !== generation || !viewer) return;
    ready.value = true; loading.value = false; fitting = true;
    viewer.currentScaleValue = 'page-width'; void navigateCitation();
  }, { signal });
  bus.on('pagechanging', ({ pageNumber: page }: {pageNumber: number}) => { pageNumber.value = page; }, { signal });
  bus.on('scalechanging', ({ scale }: {scale: number}) => { scalePercent.value = Math.round(scale * 100); paintHighlights(); }, { signal });
  bus.on('pagerendered', ({ error: renderError }: {error?: unknown}) => {
    if (renderError) fail(renderError); else paintHighlights();
  }, { signal });
  bus.on('textlayerrendered', paintHighlights, { signal });
  bus.on('updatefindmatchescount', ({ matchesCount }: {matchesCount: { current: number; total: number }}) => {
    findStatus.value = `${matchesCount.current} / ${matchesCount.total}`;
  }, { signal });
  bus.on('updatefindcontrolstate', ({ state, matchesCount }: {state: number; matchesCount: {current: number; total: number}}) => {
    findStatus.value = state === 1 ? '没有匹配' : state === 3 ? '正在搜索…' : `${matchesCount.current} / ${matchesCount.total}`;
  }, { signal });
  resizeObserver = new ResizeObserver(() => { if (fitting && viewer && ready.value) viewer.currentScaleValue = 'page-width'; });
  resizeObserver.observe(container.value);
  try {
    loadingTask = getDocument({ url: props.url, httpHeaders: getAuthHeaders(), withCredentials: true,
      cMapUrl: `${assetsUrl}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assetsUrl}standard_fonts/`, wasmUrl: `${assetsUrl}wasm/`,
      rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true });
    loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => { if (current === generation && total) progress.value = Math.min(100, Math.round(loaded / total * 100)); };
    const pdf = await loadingTask.promise;
    if (current !== generation || !viewer) return;
    document = pdf; pageCount.value = pdf.numPages; links?.setDocument(pdf); viewer.setDocument(pdf);
  } catch (cause) { if (current === generation) fail(cause); }
}
function fail(cause: unknown) {
  const status = (cause as { status?: number })?.status;
  if (status === 401) handleUnauthorized();
  loading.value = false; ready.value = false;
  error.value = status === 404 ? '此版本的 PDF 原件已不可用，仍可核对保存的引用快照。' : 'PDF 原件加载失败，请重试；保存的引用快照仍可核对。';
  emit('unavailable', true);
  viewer?.setDocument(null);
}
function retry() { void load(); }
watch(() => props.citation, () => { void navigateCitation(); });
onMounted(() => { void load(); });
onBeforeUnmount(() => { disposed = true; loadSequence++; void dispose(); });
</script>
