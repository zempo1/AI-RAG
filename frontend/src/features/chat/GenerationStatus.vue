<template>
  <div class="generation-status" role="status" aria-live="polite" aria-atomic="true" :class="{ reconnecting }">
    <span class="activity-dot" aria-hidden="true"></span>
    <span v-if="background" class="background-label">后台</span>
    <span class="activity-title">{{ summary || labels[hasContent ? 'writing' : stage] || '正在准备回答…' }}</span>
    <small v-if="background" class="activity-hint" :title="reconnecting ? '后台任务仍会继续，连接恢复后自动更新；完成后保存到当前会话。' : '任务完成后会保存到当前会话，重新打开即可查看。'">{{ reconnecting ? '任务继续运行' : '可离开，完成后自动保存' }}</small>
  </div>
</template>
<script setup lang="ts">
defineProps<{ stage: string; hasContent: boolean; summary?: string; background?: boolean; reconnecting?: boolean }>();
const labels: Record<string, string> = {
  connecting: '正在连接…', understanding: '正在理解问题…', retrieving: '正在查看来源…',
  reranking: '正在核对资料…', organizing: '正在整理证据…', generating: '正在组织答案…', writing: '正在生成…',
};
</script>
<style scoped>
.generation-status { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 6px 0; text-align: left; min-height: 24px; }
.activity-dot { flex: 0 0 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--el-color-primary-light-3, #c4b5fd); animation: breathe 1.6s ease-in-out infinite; }
.background-label { flex-shrink: 0; border: 1px solid var(--border-color); border-radius: 4px; padding: 0 5px; font-size: 12px; line-height: 20px; color: var(--text-secondary); }
.activity-title { min-width: 0; font-size: 13px; line-height: 22px; color: var(--text-primary); overflow-wrap: anywhere; }
.activity-hint { font-size: 12px; line-height: 20px; color: var(--text-secondary); }
.reconnecting .activity-dot { background: var(--el-color-warning, #d5bb90); }
@keyframes breathe { 0%,100% { opacity: .45; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .activity-dot { animation: none; } }
</style>
