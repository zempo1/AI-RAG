<template>
  <aside class="workbench" :class="{ collapsed: isCollapsed }">
    <!-- 折叠状态 -->
    <div v-if="isCollapsed" class="collapsed-strip" @click="isCollapsed = false">
      <el-tooltip content="展开工作台" placement="left">
        <div class="expand-btn"><el-icon><ArrowLeft /></el-icon></div>
      </el-tooltip>
      <span class="vertical-label">工作台</span>
    </div>

    <template v-else>
      <!-- 标题栏 -->
      <div class="wb-header">
        <div class="wb-title">
          <el-icon class="wb-title-icon"><Grid /></el-icon>
          <span>工作台</span>
        </div>
        <el-tooltip content="收起工作台" placement="left">
          <div class="collapse-btn" @click="isCollapsed = true">
            <el-icon><ArrowRight /></el-icon>
          </div>
        </el-tooltip>
      </div>

      <!-- Tab -->
      <div class="wb-tabs">
        <div v-for="tab in tabs" :key="tab.key"
          class="wb-tab" :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key">
          <span>{{ tab.label }}</span>
        </div>
      </div>

      <!-- ===== 思维导图 ===== -->
      <template v-if="activeTab === 'mindmap'">
        <div class="wb-section generate-section">
          <!-- 激活文件 -->
          <div v-if="uploadedFileName" class="active-file">
            <el-icon class="file-icon"><Document /></el-icon>
            <el-tooltip :content="uploadedFileName" placement="right" :show-after="400" :hide-after="0">
              <span class="file-name">{{ uploadedFileName }}</span>
            </el-tooltip>
          </div>
          <div v-else class="no-file">
            <el-icon><InfoFilled /></el-icon>
            <span>请先在左侧上传或激活文件</span>
          </div>
          <el-button class="generate-btn" type="primary"
            :disabled="!uploadedFileName || !props.uploadedDocumentId"
            :loading="mindmapGenerating" @click="handleGenerateMindMap">
            <el-icon class="el-icon--left"><Connection /></el-icon>
            生成思维导图
          </el-button>
        </div>
        <div class="wb-divider" />
        <div class="history-scroll">
          <div class="section-label">历史记录</div>
          <div v-if="mindmapLoading" class="list-empty">加载中…</div>
          <div v-else-if="mindMaps.length === 0" class="list-empty">暂无思维导图</div>
          <div v-for="map in mindMaps" :key="map.id" class="map-item" @click="handleOpenMindMap(map)">
            <div class="map-item-content">
              <el-icon class="map-icon"><Connection /></el-icon>
              <div class="map-info">
                <el-tooltip :content="map.title" placement="right" :show-after="400" :hide-after="0">
                  <span class="map-title">{{ map.title }}</span>
                </el-tooltip>
                <span class="map-time">{{ formatTime(map.createdAt) }}</span>
              </div>
            </div>
            <div class="map-actions">
              <el-icon class="delete-icon" @click.stop="handleDeleteMindMap(map.id)"><Delete /></el-icon>
            </div>
          </div>
        </div>
      </template>

      <!-- ===== AI 摘要 ===== -->
      <template v-else-if="activeTab === 'summary'">
        <div class="wb-section generate-section">
          <div v-if="uploadedFileName" class="active-file">
            <el-icon class="file-icon"><Document /></el-icon>
            <el-tooltip :content="uploadedFileName" placement="right" :show-after="400" :hide-after="0">
              <span class="file-name">{{ uploadedFileName }}</span>
            </el-tooltip>
          </div>
          <div v-else class="no-file">
            <el-icon><InfoFilled /></el-icon>
            <span>请先在左侧上传或激活文件</span>
          </div>
          <el-button class="generate-btn" type="primary"
            :disabled="!uploadedFileName || !props.uploadedDocumentId"
            :loading="summaryGenerating" @click="handleGenerate('SUMMARY')">
            <el-icon class="el-icon--left"><Memo /></el-icon>
            生成 AI 摘要
          </el-button>
        </div>
        <div class="wb-divider" />
        <div class="history-scroll">
          <div class="section-label">历史记录</div>
          <div v-if="summaryLoading" class="list-empty">加载中…</div>
          <div v-else-if="summaries.length === 0" class="list-empty">暂无摘要记录</div>
          <div v-for="item in summaries" :key="item.id" class="analysis-item">
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
                  <el-icon class="export-icon" @click.stop="exportMarkdown(item)"><Download /></el-icon>
                </el-tooltip>
                <el-icon class="delete-icon" @click.stop="handleDeleteAnalysis(item.id)"><Delete /></el-icon>
              </div>
            </div>
            <div v-if="expandedId === item.id" class="analysis-content" v-html="renderMarkdown(item.content)" />
          </div>
        </div>
      </template>

      <!-- ===== 文档大纲 ===== -->
      <template v-else-if="activeTab === 'outline'">
        <div class="wb-section generate-section">
          <div v-if="uploadedFileName" class="active-file">
            <el-icon class="file-icon"><Document /></el-icon>
            <el-tooltip :content="uploadedFileName" placement="right" :show-after="400" :hide-after="0">
              <span class="file-name">{{ uploadedFileName }}</span>
            </el-tooltip>
          </div>
          <div v-else class="no-file">
            <el-icon><InfoFilled /></el-icon>
            <span>请先在左侧上传或激活文件</span>
          </div>
          <el-button class="generate-btn" type="primary"
            :disabled="!uploadedFileName || !props.uploadedDocumentId"
            :loading="outlineGenerating" @click="handleGenerate('OUTLINE')">
            <el-icon class="el-icon--left"><List /></el-icon>
            生成文档大纲
          </el-button>
        </div>
        <div class="wb-divider" />
        <div class="history-scroll">
          <div class="section-label">历史记录</div>
          <div v-if="outlineLoading" class="list-empty">加载中…</div>
          <div v-else-if="outlines.length === 0" class="list-empty">暂无大纲记录</div>
          <div v-for="item in outlines" :key="item.id" class="analysis-item">
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
                  <el-icon class="export-icon" @click.stop="exportMarkdown(item)"><Download /></el-icon>
                </el-tooltip>
                <el-icon class="delete-icon" @click.stop="handleDeleteAnalysis(item.id)"><Delete /></el-icon>
              </div>
            </div>
            <div v-if="expandedId === item.id" class="analysis-content" v-html="renderMarkdown(item.content)" />
          </div>
        </div>
      </template>
    </template>

    <MindMapEditor v-model="editorVisible" :mind-map-data="currentMindMap" @saved="onMindMapSaved" />
  </aside>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  ArrowLeft, ArrowRight, Grid, Connection, Document,
  InfoFilled, Delete, List, Memo, Download,
} from '@element-plus/icons-vue'
import MindMapEditor from './MindMapEditor.vue'
import { generateMindMap, getMindMaps, deleteMindMap as apiDeleteMindMap, type MindMap } from '../api/mindmap'
import { generateAnalysis, getAnalyses, deleteAnalysis as apiDeleteAnalysis, type DocumentAnalysis } from '../api/analysis'
import { useToast } from '../composables/useToast'
import { useConfirm } from '../composables/useConfirm'

const props = defineProps<{
  uploadedFileName: string
  uploadedDocumentId: number | null
}>()

const toast = useToast()
const confirm = useConfirm()

const tabs: { key: 'mindmap' | 'summary' | 'outline'; label: string }[] = [
  { key: 'mindmap', label: '思维导图' },
  { key: 'summary', label: 'AI 摘要' },
  { key: 'outline', label: '文档大纲' },
]
const activeTab = ref<'mindmap' | 'summary' | 'outline'>('mindmap')
const isCollapsed = ref(false)

// 思维导图
const mindmapGenerating = ref(false)
const mindmapLoading = ref(false)
const mindMaps = ref<MindMap[]>([])
const editorVisible = ref(false)
const currentMindMap = ref<MindMap | null>(null)

// 摘要
const summaryGenerating = ref(false)
const summaryLoading = ref(false)
const summaries = ref<DocumentAnalysis[]>([])

// 大纲
const outlineGenerating = ref(false)
const outlineLoading = ref(false)
const outlines = ref<DocumentAnalysis[]>([])

// 展开
const expandedId = ref<number | null>(null)
const toggleExpand = (id: number) => { expandedId.value = expandedId.value === id ? null : id }

// 加载
const loadMindMaps = async () => {
  mindmapLoading.value = true
  try { mindMaps.value = await getMindMaps() } catch (e) { console.error(e) }
  finally { mindmapLoading.value = false }
}
const loadSummaries = async () => {
  summaryLoading.value = true
  try { summaries.value = await getAnalyses('SUMMARY') } catch (e) { console.error(e) }
  finally { summaryLoading.value = false }
}
const loadOutlines = async () => {
  outlineLoading.value = true
  try { outlines.value = await getAnalyses('OUTLINE') } catch (e) { console.error(e) }
  finally { outlineLoading.value = false }
}

onMounted(() => { loadMindMaps(); loadSummaries(); loadOutlines() })

// 思维导图操作
const handleGenerateMindMap = async () => {
  if (!props.uploadedDocumentId) { toast.error('请先选择文件'); return }
  mindmapGenerating.value = true
  try {
    const map = await generateMindMap(props.uploadedDocumentId)
    currentMindMap.value = map; editorVisible.value = true
    toast.success('思维导图生成成功！')
    await loadMindMaps()
  } catch (e) { console.error(e); toast.error('生成思维导图失败') }
  finally { mindmapGenerating.value = false }
}
const handleOpenMindMap = (map: MindMap) => { currentMindMap.value = map; editorVisible.value = true }
const handleDeleteMindMap = async (id: number) => {
  const ok = await confirm.danger('确定要删除这个思维导图吗？删除后无法恢复。', '删除确认')
  if (!ok) return
  try { await apiDeleteMindMap(id); mindMaps.value = mindMaps.value.filter(m => m.id !== id); toast.success('已删除') }
  catch (e) { console.error(e); toast.error('删除失败') }
}
const onMindMapSaved = () => { loadMindMaps() }

// 摘要/大纲操作
const handleGenerate = async (type: 'SUMMARY' | 'OUTLINE') => {
  if (!props.uploadedDocumentId) { toast.error('请先选择文件'); return }
  if (type === 'SUMMARY') summaryGenerating.value = true
  else outlineGenerating.value = true
  try {
    await generateAnalysis(props.uploadedDocumentId, type)
    toast.success(type === 'SUMMARY' ? 'AI 摘要生成成功！' : '文档大纲生成成功！')
    if (type === 'SUMMARY') await loadSummaries()
    else await loadOutlines()
  } catch (e) { console.error(e); toast.error(type === 'SUMMARY' ? '生成摘要失败' : '生成大纲失败') }
  finally {
    if (type === 'SUMMARY') summaryGenerating.value = false
    else outlineGenerating.value = false
  }
}
const handleDeleteAnalysis = async (id: number) => {
  const ok = await confirm.danger('确定要删除这条记录吗？', '删除确认')
  if (!ok) return
  try {
    await apiDeleteAnalysis(id)
    summaries.value = summaries.value.filter(s => s.id !== id)
    outlines.value = outlines.value.filter(o => o.id !== id)
    if (expandedId.value === id) expandedId.value = null
    toast.success('已删除')
  } catch (e) { console.error(e); toast.error('删除失败') }
}

function exportMarkdown(item: DocumentAnalysis) {
  const typeLabel = item.type === 'SUMMARY' ? 'AI摘要' : '文档大纲'
  const header = `# ${typeLabel} — ${item.documentName}\n\n> 生成时间：${new Date(item.createdAt).toLocaleString('zh-CN')}\n\n---\n\n`
  const blob = new Blob([header + item.content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${item.documentName}_${typeLabel}_${item.id}.md`
  a.click()
  URL.revokeObjectURL(url)
  toast.success('已导出为 Markdown 文件')
}

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

defineExpose({ loadMindMaps, loadSummaries, loadOutlines })
</script>

<style lang="scss" scoped>
.workbench {
  width: 300px;
  background-color: var(--bg-sidebar);
  border-left: 1px solid var(--border-color);
  display: flex; flex-direction: column;
  transition: width 0.3s ease;
  overflow: hidden; flex-shrink: 0;
  &.collapsed { width: 40px; }
}

.collapsed-strip {
  width: 40px; height: 100%;
  display: flex; flex-direction: column; align-items: center;
  padding-top: 16px; gap: 12px; cursor: pointer;
  .expand-btn {
    width: 32px; height: 32px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-secondary); transition: all 0.2s;
    &:hover { background: var(--bg-hover); color: var(--text-primary); }
    .el-icon { font-size: 14px; }
  }
  .vertical-label {
    writing-mode: vertical-rl; font-size: 0.75rem; font-weight: 600;
    color: var(--text-secondary); letter-spacing: 0.1em; user-select: none;
  }
}

.wb-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 14px 10px; flex-shrink: 0;
  .wb-title {
    display: flex; align-items: center; gap: 8px;
    font-size: 0.875rem; font-weight: 600; color: var(--text-primary);
    .wb-title-icon { font-size: 16px; color: var(--accent-color); }
  }
  .collapse-btn {
    width: 28px; height: 28px; border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-secondary); cursor: pointer; transition: all 0.2s;
    &:hover { background: var(--bg-hover); color: var(--text-primary); }
    .el-icon { font-size: 13px; }
  }
}

.wb-tabs {
  display: flex; border-bottom: 1px solid var(--border-color);
  flex-shrink: 0; padding: 0 6px; gap: 2px;
  .wb-tab {
    flex: 1; display: flex; align-items: center; justify-content: center;
    padding: 6px 2px; font-size: 0.72rem; font-weight: 500;
    color: var(--text-secondary); cursor: pointer;
    border-bottom: 2px solid transparent; transition: all 0.2s;
    border-radius: 4px 4px 0 0; white-space: nowrap;
    &:hover { color: var(--text-primary); background: rgba(255,255,255,0.04); }
    &.active { color: var(--accent-color); border-bottom-color: var(--accent-color); font-weight: 600; }
  }
}

.wb-section { padding: 12px 12px 10px; flex-shrink: 0; }

.wb-divider { height: 1px; background: var(--border-color); margin: 0 12px 0; flex-shrink: 0; }

.generate-section {
  .active-file {
    display: flex; align-items: center; gap: 8px;
    background: rgba(139,92,246,0.08); border: 1px solid rgba(139,92,246,0.2);
    border-radius: 8px; padding: 7px 10px; margin-bottom: 10px;
    .file-icon { font-size: 14px; color: var(--accent-color); flex-shrink: 0; }
    .file-name { font-size: 0.8rem; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  }
  .no-file {
    display: flex; align-items: center; gap: 6px;
    font-size: 0.78rem; color: var(--text-secondary); margin-bottom: 10px;
    .el-icon { font-size: 13px; }
  }
  .generate-btn {
    width: 100%; background: var(--primary-gradient); border: none;
    border-radius: 8px; font-size: 0.84rem; font-weight: 500;
    transition: opacity 0.2s, transform 0.1s;
    &:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
    &:active:not(:disabled) { transform: translateY(0); }
    &:disabled { opacity: 0.4; cursor: not-allowed; background: var(--primary-gradient); }
  }
}

// 历史滚动区域
.history-scroll {
  flex: 1; overflow-y: auto; padding: 10px 6px 6px;
  .section-label {
    font-size: 0.68rem; font-weight: 700; color: var(--text-secondary);
    text-transform: uppercase; letter-spacing: 0.08em;
    margin-bottom: 6px; padding: 0 6px;
  }
  .list-empty {
    font-size: 0.8rem; color: var(--text-secondary); text-align: center; padding: 20px 0;
  }
}

// 思维导图列表
.map-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px; border-radius: 8px; cursor: pointer;
  transition: background 0.15s; margin-bottom: 2px;
  &:hover { background: var(--bg-hover); .map-actions { opacity: 1; } }
  .map-item-content {
    display: flex; align-items: center; gap: 8px; overflow: hidden; flex: 1;
    .map-icon { font-size: 14px; color: var(--accent-color); flex-shrink: 0; }
    .map-info {
      display: flex; flex-direction: column; gap: 2px; overflow: hidden;
      .map-title { font-size: 0.82rem; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .map-time { font-size: 0.7rem; color: var(--text-secondary); }
    }
  }
  .map-actions {
    opacity: 0; transition: opacity 0.15s; flex-shrink: 0;
    .delete-icon {
      font-size: 14px; color: var(--text-secondary); padding: 4px; border-radius: 4px; transition: all 0.15s; cursor: pointer;
      &:hover { background: rgba(239,68,68,0.15); color: #ef4444; }
    }
  }
}

// 摘要/大纲列表
.analysis-item {
  border: 1px solid var(--border-color); border-radius: 8px;
  margin-bottom: 6px; overflow: hidden; transition: border-color 0.2s;
  &:hover { border-color: rgba(139,92,246,0.3); }
  .analysis-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px; cursor: pointer; transition: background 0.15s;
    &:hover { background: var(--bg-hover); .delete-icon { opacity: 1 !important; } .export-icon { opacity: 1 !important; } }
    .analysis-meta {
      display: flex; flex-direction: column; gap: 2px; overflow: hidden; flex: 1; min-width: 0;
      .analysis-doc { font-size: 0.82rem; color: var(--text-primary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .analysis-time { font-size: 0.7rem; color: var(--text-secondary); }
    }
    .analysis-header-right {
      display: flex; align-items: center; gap: 5px; flex-shrink: 0; margin-left: 6px;
      .toggle-chevron { font-size: 12px; color: var(--text-secondary); transition: transform 0.2s; &.expanded { transform: rotate(90deg); } }
      .export-icon {
        font-size: 13px; color: var(--text-secondary); padding: 3px; border-radius: 4px;
        cursor: pointer; opacity: 0; transition: all 0.15s;
        &:hover { background: rgba(59,130,246,0.15); color: #3b82f6; }
      }
      .delete-icon {
        font-size: 13px; color: var(--text-secondary); padding: 3px; border-radius: 4px;
        cursor: pointer; opacity: 0; transition: all 0.15s;
        &:hover { background: rgba(239,68,68,0.15); color: #ef4444; }
      }
    }
  }
  .analysis-content {
    padding: 10px 12px; font-size: 0.82rem; line-height: 1.7; color: var(--text-primary);
    border-top: 1px solid var(--border-color); max-height: 380px; overflow-y: auto;
    background: rgba(255,255,255,0.02);
    :deep(h1) { font-size: 0.95rem; font-weight: 700; margin: 6px 0 3px; }
    :deep(h2) { font-size: 0.88rem; font-weight: 600; margin: 5px 0 2px; }
    :deep(h3) { font-size: 0.83rem; font-weight: 600; margin: 4px 0 2px; color: var(--accent-color); }
    :deep(strong) { font-weight: 700; }
    :deep(ul) { margin: 3px 0; padding-left: 14px; }
    :deep(li) { margin: 2px 0; }
    :deep(p) { margin: 3px 0; }
  }
}
</style>
