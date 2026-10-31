<template>
  <div class="history-scroll">
    <div class="section-label">历史记录</div>
    <div v-if="loading" class="list-empty">加载中…</div>
    <div v-else-if="items.length === 0" class="list-empty">{{ emptyText }}</div>
    <div v-for="item in items" :key="item.id" class="analysis-item">
      <div class="analysis-header" @click="toggleExpand(item.id)">
        <div class="analysis-meta">
          <el-tooltip
            :content="item.documentName"
            placement="right"
            :show-after="400"
            :hide-after="0"
          >
            <span class="analysis-doc">{{ item.documentName }}</span>
          </el-tooltip>
          <span class="analysis-time">{{ formatTime(item.createdAt) }}</span>
          <el-tag v-if="item.sourceOutdated" type="warning" size="small"
            >旧版本来源</el-tag
          >
        </div>
        <div class="analysis-header-right">
          <el-icon
            class="toggle-chevron"
            :class="{ expanded: expandedId === item.id }"
            ><ArrowRight
          /></el-icon>
          <el-tooltip content="导出 Markdown" placement="left" :hide-after="0">
            <el-icon class="export-icon" @click.stop="$emit('export', item)"
              ><Download
            /></el-icon>
          </el-tooltip>
          <el-icon class="delete-icon" @click.stop="$emit('delete', item)"
            ><Delete
          /></el-icon>
        </div>
      </div>
      <div
        v-if="expandedId === item.id"
        class="analysis-content"
        v-html="renderMarkdown(item.content)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ArrowRight, Download, Delete } from "@element-plus/icons-vue";
import type { DocumentAnalysis } from "../../../../api/analysis";

const {
  items,
  loading,
  emptyText = "暂无记录",
} = defineProps<{
  items: DocumentAnalysis[];
  loading: boolean;
  emptyText?: string;
}>();

const emit = defineEmits<{
  (e: "export", item: DocumentAnalysis): void;
  (e: "delete", item: DocumentAnalysis): void;
}>();

const expandedId = ref<number | null>(null);
const toggleExpand = (id: number) => {
  expandedId.value = expandedId.value === id ? null : id;
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays === 0)
    return (
      "今天 " +
      d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    );
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays} 天前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (s) => `<ul>${s}</ul>`)
    .replace(/\n\n+/g, "</p><p>")
    .replace(/^(?!<[hul])(.+)$/gm, (_, p) => (p.trim() ? `<p>${p}</p>` : ""));
}
</script>

<style lang="scss" scoped>
@use "./AnalysisList.scss";
</style>
