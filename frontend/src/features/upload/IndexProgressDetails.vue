<template>
  <div v-if="progress" class="index-counts">
    <span v-for="[key, label] in stages" :key="key">
      {{ label }} {{ completed(key) }}{{ progress[key].total == null ? '（统计中）' : ' / ' + progress[key].total }}
    </span>
    <span v-if="replaying" class="cache-note">正在核对前次进度并复用缓存</span>
    <el-progress v-if="progress.pages.total" class="page-progress" :show-text="false"
      :percentage="Math.round(completed('pages') / progress.pages.total * 100)" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ProcessingTask } from "../../api/knowledge-bases";

const props = defineProps<{ progress?: ProcessingTask["indexProgress"] }>();

const stages = [
  ["pages", "解析页"],
  ["regions", "识别区域"],
  ["embedding", "向量块"],
  ["indexing", "已写入"],
] as const;
function completed(key: (typeof stages)[number][0]) {
  const current = props.progress?.[key];
  if (!current) return 0;
  const previous = key === "pages" || key === "regions" ? props.progress?.previousRecognition?.[key] ?? 0 : 0;
  return Math.min(current.total ?? Infinity, Math.max(current.completed, previous));
}
const replaying = computed(() => {
  const progress = props.progress;
  return !!progress && (completed("pages") > progress.pages.completed ||
    completed("regions") > progress.regions.completed);
});
</script>

<style scoped>
.index-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin-top: 4px;
  color: var(--el-text-color-regular);
  font-size: 12px;
  line-height: 1.5;
}
.cache-note, .page-progress {
  flex-basis: 100%;
}
</style>
