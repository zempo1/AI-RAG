<template>
  <div class="generation-status" role="status" aria-live="polite">
    <span class="activity-dot" aria-hidden="true"></span>
    <span class="activity-title">{{ labels[hasContent ? 'writing' : stage] || '正在准备回答…' }}</span>
  </div>
</template>
<script setup lang="ts">
defineProps<{ stage: string; hasContent: boolean }>();
const labels: Record<string, string> = {
  connecting: '正在连接…', understanding: '正在理解问题…', retrieving: '正在查看来源…',
  reranking: '正在核对资料…', organizing: '正在整理证据…', generating: '正在组织答案…', writing: '正在生成…',
};
</script>
<style scoped>
.generation-status { display: flex; align-items: center; gap: 10px; padding: 10px 0; text-align: left; min-height: 24px; }
.activity-dot { flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%; background: #c4b5fd; animation: breathe 1.6s ease-in-out infinite; }
.activity-title { font-size: 14px; line-height: 24px; color: #c9c5d3; }
@keyframes breathe { 0%,100% { opacity: .45; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .activity-dot { animation: none; } }
</style>
