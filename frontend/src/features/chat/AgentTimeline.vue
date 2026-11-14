<template>
  <section class="agent-progress" aria-label="Agent 执行步骤">
    <p v-if="active" class="agent-activity" role="status" aria-live="polite" aria-atomic="true">{{ latestSummary }}</p>
    <details class="agent-step-details">
      <summary>执行步骤（{{ steps.length }}）</summary>
      <ol class="agent-timeline">
      <li v-for="step in steps" :key="`${step.runId}:${step.sequence}`">
        <strong>{{ labels[step.kind] || '执行步骤' }}</strong> · {{ step.summary }}
        <small v-if="step.tool">工具：{{ step.tool }}</small>
        <small v-if="step.evidenceCount != null">证据 {{ step.evidenceCount }} 条</small>
        <small v-if="step.elapsedMs != null">{{ (step.elapsedMs / 1000).toFixed(1) }} 秒</small>
        <span v-for="(source, index) in step.sources || []" :key="index" class="agent-source">
          {{ source.filename }}<template v-if="source.page != null"> · 第 {{ source.page }} 页</template>
        </span>
      </li>
      </ol>
    </details>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { AgentStep } from '../../utils/agent-progress';
const props = defineProps<{ steps: AgentStep[]; active?: boolean }>();
const latestSummary = computed(() => props.steps.at(-1)?.summary || '正在处理任务…');
const labels: Record<string, string> = { plan:'任务规划',tool_start:'正在调用工具',tool_end:'工具完成',assessment:'检查证据',handoff:'转入后台',stop:'执行结束' };
</script>
<style scoped>
.agent-progress { margin: 12px 0; font-size: 13px; color: var(--text-secondary); }
.agent-activity { color: var(--text-primary); }
.agent-step-details > summary { cursor: pointer; padding: 6px 0; width: fit-content; }
.agent-step-details > summary:focus-visible { outline: 2px solid var(--text-primary); outline-offset: 3px; border-radius: 3px; }
.agent-timeline { margin: 8px 0; padding-left: 24px; }
.agent-timeline li { margin: 8px 0; line-height: 1.6; overflow-wrap: anywhere; }
.agent-timeline strong { color: var(--text-primary); font-weight: 500; }
small { display: inline-block; margin-left: 8px; }
.agent-source { display: block; }
</style>
