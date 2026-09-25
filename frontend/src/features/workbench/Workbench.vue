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

      <!-- ===== 学习卡片 ===== -->
      <template v-else-if="activeTab === 'flashcard'">
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
            :loading="flashcardGenerating" @click="handleGenerate('FLASHCARD')">
            <el-icon class="el-icon--left"><Memo /></el-icon>
            生成学习卡片
          </el-button>
        </div>
        <div class="wb-divider" />
        <div class="history-scroll">
          <div class="section-label">历史记录</div>
          <div v-if="flashcardLoading" class="list-empty">加载中…</div>
          <div v-else-if="flashcards.length === 0" class="list-empty">暂无学习卡片</div>
          <div v-for="item in flashcards" :key="item.id" class="map-item"
            @click="currentFlashcard = item; flashcardViewerVisible = true">
            <div class="map-item-content">
              <el-icon class="map-icon"><Memo /></el-icon>
              <div class="map-info">
                <el-tooltip :content="item.documentName" placement="right" :show-after="400" :hide-after="0">
                  <span class="map-title">{{ item.documentName }}</span>
                </el-tooltip>
                <span class="map-time">卡片集 &middot; {{ formatTime(item.createdAt) }}</span>
              </div>
            </div>
            <div class="map-actions">
              <el-icon class="delete-icon" @click.stop="handleDeleteAnalysis(item.id)"><Delete /></el-icon>
            </div>
          </div>
        </div>
      </template>
    </template>

    <MindMapEditor v-model="editorVisible" :mind-map-data="currentMindMap" @saved="onMindMapSaved" />
    <FlashcardViewer
      v-model="flashcardViewerVisible"
      :content="currentFlashcard?.content ?? ''"
      :doc-name="currentFlashcard?.documentName ?? ''"
    />
  </aside>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  ArrowLeft, ArrowRight, Grid, Connection, Document,
  InfoFilled, Delete, List, Memo, Download,
} from '@element-plus/icons-vue'
import MindMapEditor from '../mindmap/MindMapEditor.vue'
import FlashcardViewer from '../flashcard/FlashcardViewer.vue'
import { generateMindMap, getMindMaps, deleteMindMap as apiDeleteMindMap, type MindMap } from '../../api/mindmap'
import { generateAnalysis, getAnalyses, deleteAnalysis as apiDeleteAnalysis, type DocumentAnalysis } from '../../api/analysis'
import { useToast } from '../../composables/useToast'
import { useConfirm } from '../../composables/useConfirm'

const props = defineProps<{
  uploadedFileName: string
  uploadedDocumentId: number | null
}>()

const toast = useToast()
const confirm = useConfirm()

const tabs: { key: 'mindmap' | 'summary' | 'outline' | 'flashcard'; label: string }[] = [
  { key: 'mindmap', label: '思维导图' },
  { key: 'summary', label: 'AI 摘要' },
  { key: 'outline', label: '文档大纲' },
  { key: 'flashcard', label: '学习卡片' },
]
const activeTab = ref<'mindmap' | 'summary' | 'outline' | 'flashcard'>('mindmap')
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

// 学习卡片
const flashcardGenerating = ref(false)
const flashcardLoading = ref(false)
const flashcards = ref<DocumentAnalysis[]>([])
const flashcardViewerVisible = ref(false)
const currentFlashcard = ref<DocumentAnalysis | null>(null)

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
const loadFlashcards = async () => {
  flashcardLoading.value = true
  try { flashcards.value = await getAnalyses('FLASHCARD') } catch (e) { console.error(e) }
  finally { flashcardLoading.value = false }
}

onMounted(() => { loadMindMaps(); loadSummaries(); loadOutlines(); loadFlashcards() })

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
const handleGenerate = async (type: 'SUMMARY' | 'OUTLINE' | 'FLASHCARD') => {
  if (!props.uploadedDocumentId) { toast.error('请先选择文件'); return }
  if (type === 'SUMMARY') summaryGenerating.value = true
  else if (type === 'OUTLINE') outlineGenerating.value = true
  else flashcardGenerating.value = true
  try {
    const result = await generateAnalysis(props.uploadedDocumentId, type)
    if (type === 'SUMMARY') { toast.success('AI 摘要生成成功！'); await loadSummaries() }
    else if (type === 'OUTLINE') { toast.success('文档大纲生成成功！'); await loadOutlines() }
    else { toast.success('学习卡片生成成功！'); await loadFlashcards(); currentFlashcard.value = result; flashcardViewerVisible.value = true }
  } catch (e) { console.error(e); toast.error('生成失败，请重试') }
  finally {
    if (type === 'SUMMARY') summaryGenerating.value = false
    else if (type === 'OUTLINE') outlineGenerating.value = false
    else flashcardGenerating.value = false
  }
}
const handleDeleteAnalysis = async (id: number) => {
  const ok = await confirm.danger('确定要删除这条记录吗？', '删除确认')
  if (!ok) return
  try {
    await apiDeleteAnalysis(id)
    summaries.value = summaries.value.filter(s => s.id !== id)
    outlines.value = outlines.value.filter(o => o.id !== id)
    flashcards.value = flashcards.value.filter(f => f.id !== id)
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

<style lang="scss" src="./Workbench.scss" scoped></style>