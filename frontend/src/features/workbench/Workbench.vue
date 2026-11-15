<template>
  <aside class="workbench" :class="{ collapsed: isCollapsed }">
    <!-- 折叠状态 -->
    <div v-if="isCollapsed" class="collapsed-strip" @click="isCollapsed = false">
      <el-tooltip content="展开工作台" placement="left">
        <div class="expand-btn">
          <el-icon><ArrowLeft /></el-icon>
        </div>
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
        <div
          v-for="tab in tabs"
          :key="tab.key"
          class="wb-tab"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
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
          :items="mindMaps"
          :icon="Connection"
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
          :items="flashcards"
          :icon="Memo"
          :loading="flashcardLoading"
          empty-text="暂无学习卡片"
          :get-title="(it: any) => it.documentName"
          :get-subtitle="(it: any) => '卡片集 · ' + formatTime(it.createdAt)"
          @open="openFlashcard"
          @delete="handleDeleteAnalysis"
        />
      </template>
    </template>

    <MindMapEditor
      v-model="editorVisible"
      :mind-map-data="currentMindMap"
      @saved="onMindMapSaved"
    />
    <FlashcardViewer
      v-model="flashcardViewerVisible"
      :content="currentFlashcard?.content ?? ''"
      :doc-name="currentFlashcard?.documentName ?? ''"
    />
  </aside>
</template>

<script setup lang="ts">
import { ref, watch, type Ref } from "vue";
import { ArrowLeft, ArrowRight, Grid, Connection, List, Memo } from "@element-plus/icons-vue";
import MindMapEditor from "../mindmap/MindMapEditor.vue";
import FlashcardViewer from "../flashcard/FlashcardViewer.vue";
import GenerateSection from "./components/GenerateSection/GenerateSection.vue";
import HistoryList from "./components/HistoryList/HistoryList.vue";
import AnalysisList from "./components/AnalysisList/AnalysisList.vue";
import {
  generateMindMap,
  getMindMaps,
  deleteMindMap as apiDeleteMindMap,
  type MindMap,
} from "../../api/mindmap";
import {
  generateAnalysis,
  getAnalyses,
  deleteAnalysis as apiDeleteAnalysis,
  type DocumentAnalysis,
} from "../../api/analysis";
import { useToast } from "../../composables/useToast";
import { useConfirm } from "../../composables/useConfirm";

const props = defineProps<{
  uploadedFileName: string;
  uploadedDocumentId: number | null;
}>();

const toast = useToast();
const confirm = useConfirm();

const tabs: {
  key: "mindmap" | "summary" | "outline" | "flashcard";
  label: string;
}[] = [
  { key: "mindmap", label: "思维导图" },
  { key: "summary", label: "AI 摘要" },
  { key: "outline", label: "文档大纲" },
  { key: "flashcard", label: "学习卡片" },
];
const activeTab = ref<"mindmap" | "summary" | "outline" | "flashcard">("mindmap");
const isCollapsed = ref(false);

// 思维导图
const mindmapGenerating = ref(false);
const mindmapLoading = ref(false);
const mindMaps = ref<MindMap[]>([]);
const editorVisible = ref(false);
const currentMindMap = ref<MindMap | null>(null);

// 摘要
const summaryGenerating = ref(false);
const summaryLoading = ref(false);
const summaries = ref<DocumentAnalysis[]>([]);

// 大纲
const outlineGenerating = ref(false);
const outlineLoading = ref(false);
const outlines = ref<DocumentAnalysis[]>([]);

// 学习卡片
const flashcardGenerating = ref(false);
const flashcardLoading = ref(false);
const flashcards = ref<DocumentAnalysis[]>([]);
const flashcardViewerVisible = ref(false);
const currentFlashcard = ref<DocumentAnalysis | null>(null);

// 每个标签独立缓存：仅成功读取才有效，同一轮读取共享请求。
function createTabLoader<T>(
  loading: Ref<boolean>,
  items: Ref<T[]>,
  fetchItems: () => Promise<T[]>,
) {
  let loaded = false;
  let revision = 0;
  let pending: Promise<void> | null = null;
  const load = () => {
    if (pending) return pending;
    const requestRevision = revision;
    loaded = false;
    loading.value = true;
    pending = (async () => {
      try {
        const result = await fetchItems();
        if (requestRevision !== revision) return;
        items.value = result;
        loaded = true;
      } catch (e) {
        console.error(e);
      } finally {
        // 已失效的旧请求不能覆盖新数据或结束新请求的加载状态。
        if (requestRevision === revision) {
          loading.value = false;
          pending = null;
        }
      }
    })();
    return pending;
  };
  return {
    load,
    ensure: () => (loaded ? Promise.resolve() : load()),
    invalidate: () => {
      revision++;
      loaded = false;
      pending = null;
      loading.value = false;
    },
  };
}

const loaders = {
  mindmap: createTabLoader(mindmapLoading, mindMaps, getMindMaps),
  summary: createTabLoader(summaryLoading, summaries, () => getAnalyses("SUMMARY")),
  outline: createTabLoader(outlineLoading, outlines, () => getAnalyses("OUTLINE")),
  flashcard: createTabLoader(flashcardLoading, flashcards, () => getAnalyses("FLASHCARD")),
};
const loadMindMaps = loaders.mindmap.load;
const loadSummaries = loaders.summary.load;
const loadOutlines = loaders.outline.load;
const refreshTab = (tab: keyof typeof loaders) => {
  loaders[tab].invalidate();
  return activeTab.value === tab ? loaders[tab].ensure() : Promise.resolve();
};

// 首次访问、失效或读取失败后才按需加载。
watch(
  activeTab,
  (tab) => {
    void loaders[tab].ensure();
  },
  { immediate: true },
);

// 思维导图操作
const handleGenerateMindMap = async () => {
  if (!props.uploadedDocumentId) {
    toast.error("请先选择文件");
    return;
  }
  mindmapGenerating.value = true;
  try {
    const map = await generateMindMap(props.uploadedDocumentId);
    currentMindMap.value = map;
    editorVisible.value = true;
    toast.success("思维导图生成成功！");
    await refreshTab("mindmap");
  } catch (e) {
    console.error(e);
    toast.error("生成思维导图失败");
  } finally {
    mindmapGenerating.value = false;
  }
};
const handleOpenMindMap = (map: MindMap) => {
  currentMindMap.value = map;
  editorVisible.value = true;
};
const handleDeleteMindMap = async (map: MindMap) => {
  const ok = await confirm.danger("确定要删除这个思维导图吗？删除后无法恢复。", "删除确认");
  if (!ok) return;
  try {
    await apiDeleteMindMap(map.id);
    loaders.mindmap.invalidate();
    mindMaps.value = mindMaps.value.filter((m) => m.id !== map.id);
    toast.success("已删除");
  } catch (e) {
    console.error(e);
    toast.error("删除失败");
  }
};
const onMindMapSaved = () => {
  void refreshTab("mindmap");
};

// 摘要/大纲操作
const handleGenerate = async (type: "SUMMARY" | "OUTLINE" | "FLASHCARD") => {
  if (!props.uploadedDocumentId) {
    toast.error("请先选择文件");
    return;
  }
  if (type === "SUMMARY") summaryGenerating.value = true;
  else if (type === "OUTLINE") outlineGenerating.value = true;
  else flashcardGenerating.value = true;
  try {
    const result = await generateAnalysis(props.uploadedDocumentId, type);
    if (type === "SUMMARY") {
      toast.success("AI 摘要生成成功！");
      await refreshTab("summary");
    } else if (type === "OUTLINE") {
      toast.success("文档大纲生成成功！");
      await refreshTab("outline");
    } else {
      toast.success("学习卡片生成成功！");
      await refreshTab("flashcard");
      currentFlashcard.value = result;
      flashcardViewerVisible.value = true;
    }
  } catch (e) {
    console.error(e);
    toast.error("生成失败，请重试");
  } finally {
    if (type === "SUMMARY") summaryGenerating.value = false;
    else if (type === "OUTLINE") outlineGenerating.value = false;
    else flashcardGenerating.value = false;
  }
};
const handleDeleteAnalysis = async (item: DocumentAnalysis) => {
  const ok = await confirm.danger("确定要删除这条记录吗？", "删除确认");
  if (!ok) return;
  try {
    await apiDeleteAnalysis(item.id);
    const tab =
      item.type === "SUMMARY" ? "summary" : item.type === "OUTLINE" ? "outline" : "flashcard";
    loaders[tab].invalidate();
    summaries.value = summaries.value.filter((s) => s.id !== item.id);
    outlines.value = outlines.value.filter((o) => o.id !== item.id);
    flashcards.value = flashcards.value.filter((f) => f.id !== item.id);
    toast.success("已删除");
  } catch (e) {
    console.error(e);
    toast.error("删除失败");
  }
};

function exportMarkdown(item: DocumentAnalysis) {
  const typeLabel = item.type === "SUMMARY" ? "AI摘要" : "文档大纲";
  const header = `# ${typeLabel} — ${item.documentName}\n\n> 生成时间：${new Date(item.createdAt).toLocaleString("zh-CN")}\n\n---\n\n`;
  const blob = new Blob([header + item.content], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${item.documentName}_${typeLabel}_${item.id}.md`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success("已导出为 Markdown 文件");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays === 0)
    return "今天 " + d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays} 天前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

const openFlashcard = (item: DocumentAnalysis) => {
  currentFlashcard.value = item;
  flashcardViewerVisible.value = true;
};

const onSourceDeleted = async (documentId: number) => {
  mindMaps.value = mindMaps.value.filter((item) => item.documentId !== documentId);
  summaries.value = summaries.value.filter((item) => item.documentId !== documentId);
  outlines.value = outlines.value.filter((item) => item.documentId !== documentId);
  flashcards.value = flashcards.value.filter((item) => item.documentId !== documentId);
  if (currentMindMap.value?.documentId === documentId) {
    editorVisible.value = false;
    currentMindMap.value = null;
  }
  if (currentFlashcard.value?.documentId === documentId) {
    flashcardViewerVisible.value = false;
    currentFlashcard.value = null;
  }
  await refresh();
};

const refresh = () => {
  Object.values(loaders).forEach((loader) => loader.invalidate());
  return loaders[activeTab.value].ensure();
};
defineExpose({
  loadMindMaps,
  loadSummaries,
  loadOutlines,
  onSourceDeleted,
  refresh,
});
</script>

<style lang="scss" src="./Workbench.scss" scoped></style>
