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
        <GenerateSection
          :file-name="uploadedFileName"
          :icon="Connection"
          button-text="生成思维导图"
          :loading="mindmapGenerating"
          :disabled="!uploadedFileName || !props.uploadedDocumentId"
          @generate="handleGenerateMindMap"
        />
        <div class="wb-divider" />
        <HistoryList
          :items="mindMaps" :icon="Connection"
          :loading="mindmapLoading"
          empty-text="暂无思维导图"
          :get-title="(m: any) => m.title"
          :get-subtitle="(m: any) => formatTime(m.createdAt)"
          @open="handleOpenMindMap"
          @delete="handleDeleteMindMap"
        />
      </template>

      <!-- ===== AI 摘要 ===== -->
      <template v-else-if="activeTab === 'summary'">
        <GenerateSection
          :file-name="uploadedFileName"
          :icon="Memo"
          button-text="生成 AI 摘要"
          :loading="summaryGenerating"
          :disabled="!uploadedFileName || !props.uploadedDocumentId"
          @generate="handleGenerate('SUMMARY')"
        />
        <div class="wb-divider" />
        <AnalysisList
          :items="summaries"
          :loading="summaryLoading"
          empty-text="暂无摘要记录"
          @export="exportMarkdown"
          @delete="handleDeleteAnalysis"
        />
      </template>

      <!-- ===== 文档大纲 ===== -->
      <template v-else-if="activeTab === 'outline'">
        <GenerateSection
          :file-name="uploadedFileName"
          :icon="List"
          button-text="生成文档大纲"
          :loading="outlineGenerating"
          :disabled="!uploadedFileName || !props.uploadedDocumentId"
          @generate="handleGenerate('OUTLINE')"
        />
        <div class="wb-divider" />
        <AnalysisList
          :items="outlines"
          :loading="outlineLoading"
          empty-text="暂无大纲记录"
          @export="exportMarkdown"
          @delete="handleDeleteAnalysis"
        />
      </template>

      <!-- ===== 学习卡片 ===== -->
      <template v-else-if="activeTab === 'flashcard'">
        <GenerateSection
          :file-name="uploadedFileName"
          :icon="Memo"
          button-text="生成学习卡片"
          :loading="flashcardGenerating"
          :disabled="!uploadedFileName || !props.uploadedDocumentId"
          @generate="handleGenerate('FLASHCARD')"
        />
        <div class="wb-divider" />
        <HistoryList
          :items="flashcards" :icon="Memo"
          :loading="flashcardLoading"
          empty-text="暂无学习卡片"
          :get-title="(it: any) => it.documentName"
          :get-subtitle="(it: any) => '卡片集 · ' + formatTime(it.createdAt)"
          @open="openFlashcard"
          @delete="handleDeleteAnalysis"
        />
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
import { ref, watch } from 'vue'
import {
  ArrowLeft, ArrowRight, Grid, Connection,
  List, Memo,
} from '@element-plus/icons-vue'
import MindMapEditor from '../mindmap/MindMapEditor.vue'
import FlashcardViewer from '../flashcard/FlashcardViewer.vue'
import GenerateSection from './components/GenerateSection.vue'
import HistoryList from './components/HistoryList.vue'
import AnalysisList from './components/AnalysisList.vue'
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

// 懒加载：仅在首次切换到该 tab 时获取数据
const loaders: Record<'mindmap' | 'summary' | 'outline' | 'flashcard', () => Promise<void>> = {
  mindmap: loadMindMaps,
  summary: loadSummaries,
  outline: loadOutlines,
  flashcard: loadFlashcards,
}
const loadedTabs = new Set<string>()
watch(
  activeTab,
  (tab) => {
    if (loadedTabs.has(tab)) return
    loadedTabs.add(tab)
    loaders[tab]()
  },
  { immediate: true },
)

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
const handleDeleteMindMap = async (map: MindMap) => {
  const ok = await confirm.danger('确定要删除这个思维导图吗？删除后无法恢复。', '删除确认')
  if (!ok) return
  try { await apiDeleteMindMap(map.id); mindMaps.value = mindMaps.value.filter(m => m.id !== map.id); toast.success('已删除') }
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
const handleDeleteAnalysis = async (item: DocumentAnalysis) => {
  const ok = await confirm.danger('确定要删除这条记录吗？', '删除确认')
  if (!ok) return
  try {
    await apiDeleteAnalysis(item.id)
    summaries.value = summaries.value.filter(s => s.id !== item.id)
    outlines.value = outlines.value.filter(o => o.id !== item.id)
    flashcards.value = flashcards.value.filter(f => f.id !== item.id)
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

const openFlashcard = (item: DocumentAnalysis) => {
  currentFlashcard.value = item
  flashcardViewerVisible.value = true
}

defineExpose({ loadMindMaps, loadSummaries, loadOutlines })
</script>

<style lang="scss" src="./Workbench.scss" scoped></style>