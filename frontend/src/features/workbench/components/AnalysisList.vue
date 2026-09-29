<template>
  <div class="history-scroll">
    <div class="section-label">历史记录</div>
    <div v-if="loading" class="list-empty">加载中…</div>
    <div v-else-if="items.length === 0" class="list-empty">{{ emptyText }}</div>
    <div v-for="item in items" :key="item.id" class="analysis-item">
      <div class="analysis-header" @click="toggleExpand(item.id)">
        <div class="analysis-meta">
          <el-tooltip :content="item.documentName" placement="right" :show-after="400" :hide-after="0">
            <span class="analysis-doc">{{ item.documentName }}</span>
          </el-tooltip>
          <span class="analysis-time">{{ formatTime(item.createdAt) }}</span>
        </div>
        <div class="analysis-header-right">
          <el-icon class="toggle-chevron" :class="{ expanded: expandedId === item.id }"><ArrowRight /></el-icon>
          <el-tooltip content="导出 Markdown" placement="left" :hide-after="0">
            <el-icon class="export-icon" @click.stop="$emit('export', item)"><Download /></el-icon>
          </el-tooltip>
          <el-icon class="delete-icon" @click.stop="$emit('delete', item)"><Delete /></el-icon>
        </div>
      </div>
      <div v-if="expandedId === item.id" class="analysis-content" v-html="renderMarkdown(item.content)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ArrowRight, Download, Delete } from '@element-plus/icons-vue'
import type { DocumentAnalysis } from '../../../api/analysis'

const { items, loading, emptyText = '暂无记录' } = defineProps<{
  items: DocumentAnalysis[]
  loading: boolean
  emptyText?: string
}>()

const emit = defineEmits<{
  (e: 'export', item: DocumentAnalysis): void
  (e: 'delete', item: DocumentAnalysis): void
}>()

const expandedId = ref<number | null>(null)
const toggleExpand = (id: number) => { expandedId.value = expandedId.value === id ? null : id }

function formatTime(iso: string): string {
  const d = new Date(iso)
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (diffDays === 0) return '今天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays} 天前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, s => `<ul>${s}</ul>`)
    .replace(/\n\n+/g, '</p><p>')
    .replace(/^(?!<[hul])(.+)$/gm, (_, p) => p.trim() ? `<p>${p}</p>` : '')
}
</script>

<style scoped>
.history-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 10px 6px 6px;

  .section-label {
    font-size: 0.68rem;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 6px;
    padding: 0 6px;
  }

  .list-empty {
    font-size: 0.8rem;
    color: var(--text-secondary);
    text-align: center;
    padding: 20px 0;
  }
}

.analysis-item {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  margin-bottom: 6px;
  overflow: hidden;
  transition: border-color 0.2s;

  &:hover {
    border-color: rgba(139, 92, 246, 0.3);
  }

  .analysis-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    cursor: pointer;
    transition: background 0.15s;

    &:hover {
      background: var(--bg-hover);

      .delete-icon {
        opacity: 1 !important;
      }

      .export-icon {
        opacity: 1 !important;
      }
    }

    .analysis-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow: hidden;
      flex: 1;
      min-width: 0;

      .analysis-doc {
        font-size: 0.82rem;
        color: var(--text-primary);
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .analysis-time {
        font-size: 0.7rem;
        color: var(--text-secondary);
      }
    }

    .analysis-header-right {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
      margin-left: 6px;

      .toggle-chevron {
        font-size: 12px;
        color: var(--text-secondary);
        transition: transform 0.2s;

        &.expanded {
          transform: rotate(90deg);
        }
      }

      .export-icon {
        font-size: 13px;
        color: var(--text-secondary);
        padding: 3px;
        border-radius: 4px;
        cursor: pointer;
        opacity: 0;
        transition: all 0.15s;

        &:hover {
          background: rgba(59, 130, 246, 0.15);
          color: #3b82f6;
        }
      }

      .delete-icon {
        font-size: 13px;
        color: var(--text-secondary);
        padding: 3px;
        border-radius: 4px;
        cursor: pointer;
        opacity: 0;
        transition: all 0.15s;

        &:hover {
          background: rgba(239, 68, 68, 0.15);
          color: #ef4444;
        }
      }
    }
  }

  .analysis-content {
    padding: 10px 12px;
    font-size: 0.82rem;
    line-height: 1.7;
    color: var(--text-primary);
    border-top: 1px solid var(--border-color);
    max-height: 380px;
    overflow-y: auto;
    background: rgba(255, 255, 255, 0.02);

    :deep(h1) {
      font-size: 0.95rem;
      font-weight: 700;
      margin: 6px 0 3px;
    }

    :deep(h2) {
      font-size: 0.88rem;
      font-weight: 600;
      margin: 5px 0 2px;
    }

    :deep(h3) {
      font-size: 0.83rem;
      font-weight: 600;
      margin: 4px 0 2px;
      color: var(--accent-color);
    }

    :deep(strong) {
      font-weight: 700;
    }

    :deep(ul) {
      margin: 3px 0;
      padding-left: 14px;
    }

    :deep(li) {
      margin: 2px 0;
    }

    :deep(p) {
      margin: 3px 0;
    }
  }
}
</style>