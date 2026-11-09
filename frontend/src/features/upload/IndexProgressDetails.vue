<template>
  <div v-if="progress" class="index-counts">
    <span v-for="[key, label] in stages" :key="key">
      {{ label }} {{ progress[key].completed }}{{ progress[key].total == null ? '（统计中）' : ' / ' + progress[key].total }}
    </span>
  </div>
</template>

<script setup lang="ts">
import type { ProcessingTask } from "../../api/knowledge-bases";

defineProps<{ progress?: ProcessingTask["indexProgress"] }>();

const stages = [
  ["pages", "解析页"],
  ["regions", "识别区域"],
  ["embedding", "向量块"],
  ["indexing", "已写入"],
] as const;
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
</style>
