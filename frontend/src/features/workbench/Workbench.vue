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
        <div class="generation-tasks" v-if="visibleTasks.length" aria-label="导图生成任务">
          <article v-for="task in visibleTasks" :key="task.id" class="generation-task">
            <template v-if="!terminal(task.status)">
              <div class="generation-topline">
                <span class="generation-indicator" aria-hidden="true"></span
                ><strong>{{ stageLabels[task.stage] || "正在生成" }}</strong
                ><span class="generation-percent">{{ generationProgress(task) }}%</span>
              </div>
              <div
                class="generation-track"
                role="progressbar"
                aria-label="思维导图生成进度"
                :aria-valuenow="generationProgress(task)"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuetext="generationRemaining(task)"
              >
                <span
                  :style="{ transform: 'scaleX(' + generationProgress(task) / 100 + ')' }"
                ></span>
              </div>
              <div class="generation-footer">
                <span>{{ generationRemaining(task) }}</span
                ><button @click="taskAction(task, true)">取消</button>
              </div>
            </template>
            <template v-else
              ><strong>生成失败</strong>
              <p>{{ task.error || "请稍后重试" }}</p>
              <button v-if="task.retryable" @click="taskAction(task)">重试生成</button></template
            >
          </article>
        </div>
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

    <FlashcardViewer
      v-model="flashcardViewerVisible"
      :content="currentFlashcard?.content ?? ''"
      :doc-name="currentFlashcard?.documentName ?? ''"
    />
  </aside>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount, type Ref, computed } from "vue";
import { ArrowLeft, ArrowRight, Grid, Connection, List, Memo } from "@element-plus/icons-vue";
import { getTask, retryTask } from "../../api/knowledge-bases";
import type { ProcessingTask } from "../../api/knowledge-bases";
import request from "../../utils/request";
import FlashcardViewer from "../flashcard/FlashcardViewer.vue";
import GenerateSection from "./components/GenerateSection/GenerateSection.vue";
import HistoryList from "./components/HistoryList/HistoryList.vue";
import AnalysisList from "./components/AnalysisList/AnalysisList.vue";
import {
  generateMindMap,
  getMindMapWorkspace,
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
  knowledgeBaseId?: number | null;
  active?: boolean;
}>();

const emit = defineEmits<{ (e: "open-mindmap", id: number): void }>();
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
const generationTasks = ref<ProcessingTask[]>([]);
let workspaceRevision = 0;
let watchedTask: number | null = null;
let requestId = crypto.randomUUID();
const terminal = (status: string) =>
  ["completed", "failed", "partial_failed", "canceled"].includes(status);
const stageLabels: Record<string, string> = {
  queued: "等待生成",
  reading: "读取文档",
  generating: "生成完整导图",
  mapping: "提炼要点",
  merging: "整理全局结构",
  validating: "校验导图",
  completed: "生成完成",
  failed: "生成失败",
  canceled: "已取消",
  retrying: "正在重试",
};
const visibleTasks = computed(() =>
  generationTasks.value.filter((task) => !terminal(task.status) || task.status === "failed"),
);
const progressClock = ref(Date.now());
const progressReceivedAt = ref(Date.now());
const elapsedSeconds = (task: ProcessingTask) =>
  Math.max(
    0,
    (task.mindmapProgress?.elapsedMs || 0) / 1000 +
      (progressClock.value - progressReceivedAt.value) / 1000,
  );
function generationProgress(task: ProcessingTask) {
  if (task.stage === "validating") return 98;
  if (task.stage === "merging") return 90;
  if (task.stage === "mapping" && task.total)
    return Math.min(84, Math.round(10 + (74 * task.completed) / task.total));
  if (task.stage === "generating")
    return Math.round(12 + 70 * (1 - Math.exp(-elapsedSeconds(task) / 35)));
  return task.stage === "reading" ? 7 : 3;
}
function generationRemaining(task: ProcessingTask) {
  if (task.stage === "queued" || task.stage === "waiting") return "排队中，正在估算时间";
  if (task.stage === "validating") return "正在完成最后校验…";
  if (task.stage === "merging") return "正在整理结构，即将完成…";
  if (task.stage === "generating") {
    const samples = generationTasks.value
      .filter((t) => t.status === "completed" && t.mindmapProgress?.strategy === "direct")
      .map((t) => (t.mindmapProgress?.elapsedMs || 0) / 1000)
      .filter((seconds) => seconds > 0)
      .sort((a, b) => a - b);
    if (samples.length) {
      const remaining = samples[Math.floor(samples.length / 2)] - elapsedSeconds(task);
      if (remaining <= 0) return "生成时间较长，正在重新估算…";
      return "预计还需约 " + Math.max(5, Math.ceil(remaining / 5) * 5) + " 秒";
    }
  }
  if (task.stage === "mapping" && task.total && task.completed > 0 && elapsedSeconds(task) > 0) {
    const remaining = Math.max(
      5,
      Math.ceil(((elapsedSeconds(task) / task.completed) * (task.total - task.completed) + 8) / 5) *
        5,
    );
    return remaining >= 60
      ? "预计还需约 " + Math.ceil(remaining / 60) + " 分钟"
      : "预计还需约 " + remaining + " 秒";
  }
  return "正在生成，剩余时间估算中…";
}
const fetchWorkspace = async () => {
  if (props.knowledgeBaseId === null) return [];
  const revision = workspaceRevision;
  const result = await getMindMapWorkspace(props.knowledgeBaseId);
  if (revision === workspaceRevision) generationTasks.value = result.generationTasks || [];
  progressReceivedAt.value = Date.now();
  return result.items || [];
};

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
  mindmap: createTabLoader(mindmapLoading, mindMaps, fetchWorkspace),
  summary: createTabLoader(summaryLoading, summaries, () => fetchAnalyses("SUMMARY")),
  outline: createTabLoader(outlineLoading, outlines, () => fetchAnalyses("OUTLINE")),
  flashcard: createTabLoader(flashcardLoading, flashcards, () => fetchAnalyses("FLASHCARD")),
};
function fetchAnalyses(type: "SUMMARY" | "OUTLINE" | "FLASHCARD") {
  return props.knowledgeBaseId === null
    ? Promise.resolve([])
    : getAnalyses(type, props.knowledgeBaseId);
}
let libraryRevision = 0;
const loadMindMaps = loaders.mindmap.load;
const loadSummaries = loaders.summary.load;
const loadOutlines = loaders.outline.load;
const refreshTab = (tab: keyof typeof loaders) => {
  if (tab === "mindmap") workspaceRevision++;
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
  const sourceId = props.uploadedDocumentId;
  const libraryId = props.knowledgeBaseId;
  try {
    const accepted = await generateMindMap(sourceId, requestId);
    if (sourceId !== props.uploadedDocumentId || libraryId !== props.knowledgeBaseId) return;
    watchedTask = accepted.taskId;
    requestId = crypto.randomUUID();
    toast.success("已加入后台生成任务");
    await refreshTab("mindmap");
  } catch (e) {
    console.error(e);
    toast.error("生成思维导图失败");
  } finally {
    mindmapGenerating.value = false;
  }
};
const handleOpenMindMap = (map: MindMap) => {
  emit("open-mindmap", map.id);
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

// 摘要/大纲操作
const handleGenerate = async (type: "SUMMARY" | "OUTLINE" | "FLASHCARD") => {
  if (!props.uploadedDocumentId) {
    toast.error("请先选择文件");
    return;
  }
  const revision = libraryRevision;
  if (type === "SUMMARY") summaryGenerating.value = true;
  else if (type === "OUTLINE") outlineGenerating.value = true;
  else flashcardGenerating.value = true;
  try {
    const result = await generateAnalysis(props.uploadedDocumentId, type);
    if (revision !== libraryRevision) return;
    if (type === "SUMMARY") {
      toast.success("AI 摘要生成成功！");
      await refreshTab("summary");
    } else if (type === "OUTLINE") {
      toast.success("文档大纲生成成功！");
      await refreshTab("outline");
    } else {
      toast.success("学习卡片生成成功！");
      await refreshTab("flashcard");
      if (revision !== libraryRevision) return;
      currentFlashcard.value = result;
      flashcardViewerVisible.value = true;
    }
  } catch (e) {
    console.error(e);
    if (revision !== libraryRevision) return;
    toast.error("生成失败，请重试");
  } finally {
    if (revision === libraryRevision) {
      if (type === "SUMMARY") summaryGenerating.value = false;
      else if (type === "OUTLINE") outlineGenerating.value = false;
      else flashcardGenerating.value = false;
    }
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
  generationTasks.value = generationTasks.value.filter((t) => t.documentId !== documentId);
  if (currentFlashcard.value?.documentId === documentId) {
    flashcardViewerVisible.value = false;
    currentFlashcard.value = null;
  }
  await refresh();
};

const refresh = () => {
  workspaceRevision++;
  Object.values(loaders).forEach((loader) => loader.invalidate());
  return loaders[activeTab.value].ensure();
};
watch(
  () => props.uploadedDocumentId,
  () => {
    requestId = crypto.randomUUID();
    watchedTask = null;
  },
);
watch(
  () => props.knowledgeBaseId,
  () => {
    libraryRevision++;
    workspaceRevision++;
    watchedTask = null;
    requestId = crypto.randomUUID();
    generationTasks.value = [];

    mindMaps.value = [];
    summaries.value = [];
    outlines.value = [];
    flashcards.value = [];
    currentFlashcard.value = null;
    flashcardViewerVisible.value = false;
    summaryGenerating.value = outlineGenerating.value = flashcardGenerating.value = false;
    Object.values(loaders).forEach((loader) => loader.invalidate());
    void loaders[activeTab.value].ensure();
  },
);
watch(
  () => props.active,
  (active) => {
    if (active !== false && activeTab.value === "mindmap") void loaders.mindmap.ensure();
  },
);
async function taskAction(task: ProcessingTask, cancel = false) {
  try {
    if (cancel) await request.post("/api/tasks/" + task.id + "/cancel");
    else {
      await retryTask(task.id);
      watchedTask = task.id;
    }
    await refreshTab("mindmap");
  } catch {
    toast.error("任务操作失败，请重试");
  }
}
const isActive = () => props.active !== false && activeTab.value === "mindmap";
let polling = false;
const progressTicker = setInterval(() => {
  progressClock.value = Date.now();
}, 1000);
const pollTimer = setInterval(async () => {
  if (polling || props.active === false || activeTab.value !== "mindmap" || document.hidden) return;
  const active = generationTasks.value.filter((t) => !terminal(t.status));
  if (!active.length) return;
  polling = true;
  const revision = workspaceRevision;
  try {
    const results = await Promise.all(active.map((t) => getTask(t.id, true)));
    if (revision !== workspaceRevision) return;
    progressReceivedAt.value = Date.now();
    for (const result of results) {
      const index = generationTasks.value.findIndex((t) => t.id === result.id);
      if (index >= 0) generationTasks.value[index] = result;
      if (
        terminal(result.status) &&
        !terminal(active.find((t) => t.id === result.id)?.status || "")
      ) {
        if (
          result.status === "completed" &&
          result.id === watchedTask &&
          result.mindmapResult &&
          isActive()
        ) {
          watchedTask = null;
          emit("open-mindmap", result.mindmapResult.mindMapId);
        }
        workspaceRevision++;
        loaders.mindmap.invalidate();
        void loaders.mindmap.ensure();
      }
    }
  } catch {
    /* 下一轮恢复，不中断后台任务 */
  } finally {
    polling = false;
  }
}, 2000);
onBeforeUnmount(() => {
  workspaceRevision++;
  clearInterval(pollTimer);
  clearInterval(progressTicker);
});
defineExpose({
  loadMindMaps,
  loadSummaries,
  loadOutlines,
  onSourceDeleted,
  refresh,
});
</script>

<style lang="scss" src="./Workbench.scss" scoped></style>
