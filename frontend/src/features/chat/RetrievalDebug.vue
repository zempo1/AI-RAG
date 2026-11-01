<template>
  <el-drawer
    :model-value="runId != null"
    class="knowledge-theme retrieval-debug"
    title="检索过程"
    size="min(100vw, 720px)"
    append-to-body
    @close="emit('close')"
  >
    <p class="debug-description">
      查看本次回答使用的来源版本、候选排序与证据预算。检索分数不等于答案正确概率。
    </p>
    <div v-if="loading" role="status">正在加载检索过程…</div>
    <div v-else-if="error" role="alert" class="qa-control-error">
      {{ error }} <el-button @click="load">重新加载</el-button>
    </div>
    <template v-else-if="data">
      <section
        v-for="section in sections"
        :key="section.key"
        class="debug-section"
      >
        <h3>{{ section.label }}</h3>
        <pre>{{ display(section.value) }}</pre>
      </section>
      <details class="debug-section">
        <summary>完整诊断记录</summary>
        <pre>{{ display(data) }}</pre>
      </details>
    </template>
  </el-drawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { getRetrievalRun } from "../../api/chat";
const props = defineProps<{ runId: number | null }>();
const emit = defineEmits<{ (e: "close"): void }>();
const data = ref<Record<string, any> | null>(null),
  loading = ref(false),
  error = ref("");
let sequence = 0;
const sections = computed(() => {
  const d = data.value || {};
  return [
    {
      key: "question",
      label: "原始问题",
      value: d.originalQuestion ?? d.question,
    },
    {
      key: "rewrite",
      label: "查询计划与改写",
      value: d.plan ??
        d.queryPlan ?? { mode: d.mode, rewrittenQuestion: d.rewrittenQuestion },
    },
    {
      key: "scope",
      label: "目标文件与生效版本",
      value: d.scope ?? d.targets ?? d.documentIds,
    },
    {
      key: "candidates",
      label: "关键词与向量候选",
      value: {
        lexical: d.candidates?.lexical ?? d.lexical ?? d.bm25,
        vector:
          d.candidates?.vector ?? d.candidates?.dense ?? d.vector ?? d.dense,
      },
    },
    {
      key: "fusion",
      label: "融合排名",
      value: d.candidates?.fused ?? d.fused ?? d.fusion ?? d.fusedCandidates,
    },
    {
      key: "rerank",
      label: "重排结果",
      value:
        d.candidates?.reranked ??
        d.reranked ??
        d.rerank ??
        d.rerankedCandidates,
    },
    {
      key: "evidence",
      label: "最终证据",
      value: d.finalEvidence ?? d.evidence ?? d.selected ?? d.sources,
    },
    {
      key: "tokens",
      label: "Token 用量与预算",
      value: d.tokens ?? d.tokenUsage ?? d.budget,
    },
    {
      key: "degraded",
      label: "降级与覆盖说明",
      value: {
        degraded: d.degraded ?? d.degradations,
        coverage: d.coverage,
        timings: d.timings,
      },
    },
  ].filter((s) => s.value !== undefined);
});
const display = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
async function load() {
  const current = ++sequence;
  data.value = null;
  error.value = "";
  if (props.runId == null) return;
  loading.value = true;
  try {
    const result = await getRetrievalRun(props.runId);
    if (current === sequence) data.value = result.payload ?? result;
  } catch {
    if (current === sequence)
      error.value = "无法读取此记录，可能已过期或无访问权限。";
  } finally {
    if (current === sequence) loading.value = false;
  }
}
watch(() => props.runId, load, { immediate: true });
onBeforeUnmount(() => sequence++);
</script>
