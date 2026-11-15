<template>
  <div class="qa-controls knowledge-theme">
    <el-select
      :model-value="documentIds"
      multiple
      collapse-tags
      collapse-tags-tooltip
      clearable
      :disabled="disabled"
      :loading="loading"
      aria-label="问答来源"
      placeholder="全部可用文档"
      popper-class="knowledge-theme knowledge-popper qa-source-popper"
      @update:model-value="emit('update:documentIds', $event)"
      @visible-change="
        (open: boolean) => {
          if (open) load();
        }
      "
    >
      <el-option
        v-for="doc in documents"
        :key="doc.id"
        :label="doc.filename"
        :value="doc.id"
      />
      <el-option
        v-for="id in unavailable"
        :key="'missing-' + id"
        :value="id"
        :label="'已不可用的文档 #' + id"
        disabled
      />
    </el-select>
    <el-select
      :model-value="mode"
      :disabled="disabled"
      aria-label="问答模式"
      popper-class="knowledge-theme knowledge-popper"
      @update:model-value="emit('update:mode', $event)"
    >
      <el-option label="自动判断" value="auto" /><el-option label="通用回答" value="general" /><el-option
        label="知识问答"
        value="search"
      /><el-option label="全文概览" value="overview" /><el-option
        label="文档比较"
        value="compare"
      />
    </el-select>
    <span v-if="error" class="qa-control-error" role="alert"
      >来源加载失败 <button @click="load()">重试</button></span
    >

  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  listLibraryDocuments,
  type ManagedDocument,
} from "../../api/knowledge-bases";
import type { QaMode } from "../../api/chat";
const props = defineProps<{
  knowledgeBaseId: number | null;
  documentIds: number[];
  mode: QaMode;
  disabled: boolean;
}>();
const emit = defineEmits<{
  (e: "update:documentIds", ids: number[]): void;
  (e: "update:mode", mode: QaMode): void;
}>();
const documents = ref<ManagedDocument[]>([]),
  loading = ref(false),
  error = ref(false);
let sequence = 0;
let flight: { id: number; controller: AbortController; request: Promise<void> } | undefined;
const unavailable = computed(() =>
  props.documentIds.filter((id) => !documents.value.some((d) => d.id === id)),
);
async function load(clear = false) {
  const id = props.knowledgeBaseId;
  if (clear) documents.value = [];
  if (flight?.id === id) return flight.request;
  flight?.controller.abort();
  const current = ++sequence;
  error.value = false;
  if (!id) { loading.value = false; flight = undefined; return; }
  loading.value = true;
  const controller = new AbortController();
  const request = fetchSources(id, current, controller.signal);
  flight = { id, controller, request };
  try { await request; }
  finally { if (flight?.request === request) flight = undefined; }
}
async function fetchSources(id: number, current: number, signal: AbortSignal) {
  try {
    const collected: ManagedDocument[] = [];
    for (let page = 1; ; page++) {
      const data = await listLibraryDocuments(id, { page, pageSize: 100 }, false, signal);
      if (current !== sequence) return;
      collected.push(...data.items.filter((d) => !!d.activeIndexRevisionId));
      if (page * 100 >= data.total || !data.items.length) break;
    }
    documents.value = collected;
  } catch {
    if (current === sequence && !signal.aborted) error.value = true;
  } finally {
    if (current === sequence) loading.value = false;
  }
}
watch(
  () => props.knowledgeBaseId,
  () => load(true),
  { immediate: true },
);
onBeforeUnmount(() => { sequence++; flight?.controller.abort(); });
</script>
