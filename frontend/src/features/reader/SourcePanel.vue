<template>
  <section class="source-panel citation-drawer" role="region" aria-label="文档阅读器" @keydown.esc.stop="emit('close')">
    <header class="source-panel-heading">
      <div><span class="reader-eyebrow">文档阅读</span><h2>{{ preview?.filename || target.citation?.filename || '正在读取文档…' }}</h2></div>
      <button ref="closeButton" class="reader-close" type="button" aria-label="关闭阅读器" title="返回聊天" @click="emit('close')"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>
    <p v-if="target.citation?.sourceDeleted" class="reader-notice" role="status">来源已删除，下面展示回答时保存的原文快照。</p>
    <p v-else-if="target.citation?.sourceOutdated" class="reader-notice" role="status">来源文档已更新，正在查看回答时使用的历史版本。</p>
    <div v-if="loading" class="reader-loading" role="status">正在读取文档信息…</div>
    <div v-else-if="failure" class="reader-failure" role="alert"><p>{{ failure }}</p><button type="button" @click="attempt++">重试加载文档</button></div>
    <PdfReader v-if="isPdf && preview?.originalAvailable && preview.originalUrl && !target.citation?.sourceDeleted"
      :key="preview.originalUrl" :url="preview.originalUrl" :citation="target.citation" @unavailable="originalFailed = $event" />
    <p v-else-if="!loading && !failure && !target.citation?.sourceDeleted && !isMarkdown" class="reader-notice" role="status">此历史版本没有可用原件，下面保留回答时的引用快照。</p>
    <div v-if="isMarkdown && preview?.text" class="reader-markdown"><pre>{{ preview.text }}</pre></div>
    <details v-if="target.citation" class="reader-evidence">
      <summary>引用原文快照<span v-if="target.citation.location?.page"> · 第 {{ target.citation.location.page }} 页</span></summary>
      <p v-if="target.citation.location?.contentType" class="reader-evidence-type">{{ contentLabel }}</p>
      <p v-if="target.citation.location?.heading" class="reader-evidence-type">{{ target.citation.location.heading }}</p>
      <p v-if="!target.citation.location?.page && !target.citation.location?.anchors?.length" class="reader-evidence-type">历史片段，位置未知</p>
      <pre class="source-text">{{ context || target.citation.text }}</pre>
      <SourcePagePreview v-if="!preview?.originalAvailable || !isPdf || originalFailed" :source="target.citation" />
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getDocumentPreview, type DocumentPreview } from '../../api/documents';
import { getCitationContext } from '../../api/knowledge-bases';
import SourcePagePreview from '../chat/SourcePagePreview.vue';
import PdfReader from './PdfReader.vue';
import type { DocumentTarget } from './types';
const props = defineProps<{ target: DocumentTarget }>();
const emit = defineEmits<{ (e:'close'):void }>();
const preview = ref<DocumentPreview>(), loading = ref(false), failure = ref(''), context = ref(''), attempt = ref(0), originalFailed = ref(false);
const closeButton = ref<HTMLButtonElement>();
const isPdf = computed(() => preview.value?.mimeType?.toLowerCase().split(';')[0] === 'application/pdf');
const isMarkdown = computed(() => ['text/markdown', 'text/plain', 'text/x-markdown'].includes(preview.value?.mimeType?.toLowerCase().split(';')[0] || ''));
const contentLabel = computed(() => ({native:'原生文字',ocr:'图片文字识别',table:'表格识别',figure:'模型生成的图解，请结合原图核对'})[props.target.citation?.location?.contentType || 'native']);
let sequence = 0;
watch([() => props.target.documentId, () => props.target.versionId, attempt], async ([id, version], _, onCleanup) => {
  const current = ++sequence, controller = new AbortController();
  onCleanup(() => controller.abort());
  preview.value = undefined; failure.value = ''; originalFailed.value = false;
  if (props.target.citation?.sourceDeleted) { loading.value = false; return; }
  loading.value = true;
  try {
    const result = await getDocumentPreview(id as number, version as number | undefined, controller.signal);
    if (current === sequence && !controller.signal.aborted) preview.value = result;
  } catch (error: any) {
    if (!controller.signal.aborted && current === sequence) failure.value = error.response?.status === 404 ? '此版本的原件已不可用，仍保留引用快照。' : '文档信息加载失败，可重试。引用快照仍保留在下方。';
  } finally { if (current === sequence) loading.value = false; }
}, { immediate: true });
watch(() => props.target.citation, (source, _, onCleanup) => {
  context.value = '';
  // 多片段引用的顶层范围只是包络；继续扩展会混入片段之间的其他段落。
  if (!source?.location || source.sourceSegments || source.sourceDeleted || source.sourceOutdated || !source.indexRevisionId || (source.location.contentType && source.location.contentType !== 'native')) return;
  const controller = new AbortController(); onCleanup(() => controller.abort());
  void getCitationContext(source, controller.signal).then(result => { if (!controller.signal.aborted && result.text.includes(source.text.trim())) context.value = result.text; }).catch(() => undefined);
}, { immediate: true });
onMounted(() => { closeButton.value?.focus({ preventScroll: true }); });
onBeforeUnmount(() => sequence++);
</script>

<style lang="scss" src="./reader.scss"></style>
