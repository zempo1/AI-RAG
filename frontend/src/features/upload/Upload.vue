<template>
  <div class="library-feature">
    <LibraryPicker
      :knowledge-base-id="knowledgeBaseId"
      :libraries="libraries"
      :current-library="currentLibrary"
      :selected-document="selectedDocument"
      :uploading="uploading"
      @change="changeLibrary"
      @manage="visible = true"
      @create="createLibrary"
      @clear="clearSource"
    />
    <el-drawer
      v-model="visible"
      class="knowledge-theme knowledge-drawer"
      :title="currentLibrary?.name || '知识库管理'"
      size="min(100vw, 980px)"
      append-to-body
    >
      <template #header>
        <div class="manager-heading">
          <span class="eyebrow">KNOWLEDGE BASE</span>
          <h2>{{ currentLibrary?.name || "知识库管理" }}</h2>
          <p>
            {{ currentLibrary?.description || "管理你的资料，让知识随时可用" }}
          </p>
        </div>
        <el-dropdown
          v-if="currentLibrary"
          trigger="click"
          popper-class="knowledge-theme knowledge-popper"
          @command="libraryCommand"
        >
          <el-button
            class="icon-button"
            aria-label="知识库操作"
            title="知识库操作"
            ><el-icon><MoreFilled /></el-icon
          ></el-button>
          <template #dropdown
            ><el-dropdown-menu
              ><el-dropdown-item command="edit">编辑知识库</el-dropdown-item
              ><el-dropdown-item
                command="rebuild"
                :disabled="!!currentLibrary.rebuildTaskId"
                >重建全库索引</el-dropdown-item
              ><el-dropdown-item command="delete" divided class="danger-item"
                >删除知识库</el-dropdown-item
              ></el-dropdown-menu
            ></template
          >
        </el-dropdown>
      </template>
      <template v-if="currentLibrary">
        <el-alert
          v-if="currentLibrary.rebuildTaskId"
          title="全库索引正在逐份重建，旧索引仍可问答；暂时不能上传或替换文档。"
          type="info"
          :closable="false"
          show-icon
        />
        <div
          class="upload-zone"
          :class="{
            'is-dragging': dragging,
            'is-disabled': !!currentLibrary.rebuildTaskId,
            'is-uploading': uploading,
          }"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="
            dragging = false;
            dropFile($event);
          "
        >
          <input
            ref="fileInput"
            type="file"
            accept=".pdf,.md"
            hidden
            @change="pickFile"
          />
          <template v-if="!uploading">
            <div class="upload-symbol">
              <el-icon><UploadFilled /></el-icon>
            </div>
            <div class="upload-copy">
              <strong>把资料放进知识库</strong
              ><span>拖入 PDF / Markdown，或选择文件上传</span
              ><small
                >单文件最多 128 MiB · 支持断点续传 · 上传后自动建立索引</small
              >
            </div>
            <el-button
              class="gradient-button"
              :disabled="!!currentLibrary.rebuildTaskId"
              @click="chooseFile()"
              ><el-icon><Plus /></el-icon>上传文档</el-button
            >
          </template>
          <template v-else>
            <div class="upload-copy">
              <strong>{{ uploadLabel }}</strong
              ><span
                >{{ paused ? "上传已暂停，可随时继续" : "正在传输文件" }} ·
                {{ uploadPercent }}%</span
              >
            </div>
            <el-progress
              :percentage="uploadPercent"
              :show-text="false"
              :stroke-width="5"
            />
            <div class="upload-controls">
              <span class="muted">解析和向量化进度将在下方显示</span
              ><el-button @click="paused = !paused">{{
                paused ? "继续上传" : "暂停上传"
              }}</el-button
              ><el-button @click="cancelUpload">取消（保留已传分片）</el-button>
            </div>
          </template>
        </div>
        <section class="documents-section" :aria-busy="loading">
          <div class="section-heading">
            <div>
              <h3>文档</h3>
              <span class="muted"
                >共 {{ total }} 份资料 · 就绪后可用于问答和工作台</span
              >
            </div>
            <el-button
              class="icon-button"
              :loading="loading"
              aria-label="刷新文档"
              title="刷新文档"
              @click="refresh"
              ><el-icon><Refresh /></el-icon
            ></el-button>
          </div>
          <div class="category-row">
            <span class="muted">分类</span>
            <div
              v-for="category in categories"
              :key="category.id"
              class="category-chip"
            >
              <span :title="category.name">{{ category.name }}</span
              ><button
                :aria-label="'编辑分类' + category.name"
                title="编辑分类"
                @click="renameCategory(category)"
              >
                <el-icon><EditPen /></el-icon></button
              ><button
                :aria-label="'删除分类' + category.name"
                title="删除分类"
                @click="removeCategory(category)"
              >
                <el-icon><Close /></el-icon>
              </button>
            </div>
            <el-button link @click="addCategory"
              ><el-icon><Plus /></el-icon>添加分类</el-button
            >
          </div>
          <div class="filters">
            <el-input
              v-model="keyword"
              placeholder="搜索文件名"
              clearable
              aria-label="搜索文件名"
              ><template #prefix
                ><el-icon><Search /></el-icon></template
            ></el-input>
            <el-select
              v-model="categoryFilter"
              placeholder="全部分类"
              clearable
              aria-label="按分类筛选"
              popper-class="knowledge-theme knowledge-popper"
              ><el-option label="未分类" :value="0" /><el-option
                v-for="category in categories"
                :key="category.id"
                :label="category.name"
                :value="category.id"
            /></el-select>
            <el-select
              v-model="statusFilter"
              placeholder="全部状态"
              clearable
              aria-label="按状态筛选"
              popper-class="knowledge-theme knowledge-popper"
              ><el-option label="待处理" value="pending" /><el-option
                label="处理中"
                value="queued" /><el-option
                label="已就绪"
                value="ready" /><el-option label="处理失败" value="failed"
            /></el-select>
          </div>
          <div v-if="loadError" class="load-error" role="alert">
            {{ loadError }}<el-button link @click="refresh">重新加载</el-button>
          </div>
          <div v-if="!loaded && loading" class="empty-state">正在加载文档…</div>
          <DocumentList
            v-else-if="documents.length"
            :documents="documents"
            :categories="categories"
            :document-id="documentId"
            :locked="!!currentLibrary.rebuildTaskId"
            :uploading="uploading"
            :state-label="stateLabel"
            @action="documentAction"
            @classify="classify"
            @retry="retryProcessingTask"
          />
          <div v-else-if="!loadError" class="empty-state">
            <el-icon><FolderOpened /></el-icon
            ><strong>{{
              keyword || categoryFilter != null || statusFilter
                ? "没有找到匹配的文档"
                : "知识库还是空的"
            }}</strong
            ><span>{{
              keyword || categoryFilter != null || statusFilter
                ? "试试调整搜索或筛选条件"
                : "上传第一份资料，开始你的知识问答"
            }}</span>
          </div>
          <el-pagination
            v-if="total > 20"
            v-model:current-page="page"
            :page-size="20"
            :total="total"
            layout="prev, pager, next, total"
            @current-change="refresh"
          />
        </section>
        <section class="tasks-section">
          <button
            class="tasks-toggle"
            :aria-expanded="showTasks"
            @click="tasksExpanded = !showTasks"
          >
            <span
              >后台任务 <small>{{ tasks.length }}</small></span
            ><span class="muted"
              >{{
                attentionTasks ? attentionTasks + " 项需要关注" : "查看处理记录"
              }}
              <el-icon :class="{ rotated: showTasks }"><ArrowDown /></el-icon
            ></span>
          </button>
          <div v-if="showTasks" class="task-list">
            <div class="task-history-actions">
              <span class="muted">移除记录不影响文档和索引</span
              ><el-button
                :loading="historyBusy"
                :disabled="
                  !tasks.some((t) =>
                    ['completed', 'canceled'].includes(t.status),
                  )
                "
                @click="clearHistory"
                >清除已完成</el-button
              >
            </div>
            <div v-if="!tasks.length" class="muted task-empty">
              暂无任务，上传文档后会在这里显示处理进度
            </div>
            <div
              v-for="task in tasks.slice(0, 12)"
              :key="task.id"
              class="task-row"
            >
              <div>
                <strong
                  >{{ kindLabels[task.kind] || task.kind }}
                  <span class="muted">#{{ task.id }}</span></strong
                ><span class="task-stage"
                  >{{
                    task.waitingReason || stageLabels[task.stage] || task.stage
                  }}
                  {{
                    task.total != null ? task.completed + "/" + task.total : ""
                  }}</span
                >
                <span v-if="task.waitingUntil" class="muted"
                  >预计
                  {{
                    new Date(task.waitingUntil).toLocaleTimeString()
                  }}
                  后开始清理</span
                >
                <div v-if="task.error" class="error-text">{{ task.error }}</div>
              </div>
              <div class="task-history-actions">
                <el-button
                  v-if="
                    ['failed', 'partial_failed'].includes(task.status) &&
                    task.retryable
                  "
                  @click="retryProcessingTask(task)"
                  >重试</el-button
                ><el-button
                  v-if="task.canDismiss"
                  :disabled="historyBusy"
                  @click="removeTask(task)"
                  >移除记录</el-button
                >
              </div>
            </div>
          </div>
        </section>
      </template>
      <div v-else class="empty-state">
        <el-icon><Collection /></el-icon><strong>知识库已删除或不可用</strong
        ><span>请返回并选择其他知识库，历史聊天仍可查看。</span>
      </div>
    </el-drawer>
    <KnowledgeForm ref="editor" />
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import {
  MoreFilled,
  UploadFilled,
  Plus,
  Refresh,
  EditPen,
  Close,
  Search,
  FolderOpened,
  ArrowDown,
  Collection,
} from "@element-plus/icons-vue";
import LibraryPicker from "./LibraryPicker.vue";
import DocumentList from "./DocumentList.vue";
import KnowledgeForm from "./KnowledgeForm.vue";
import * as api from "../../api/knowledge-bases";
import type {
  Category,
  KnowledgeBase,
  ManagedDocument,
  ProcessingTask,
  AcceptedDocument,
} from "../../api/knowledge-bases";
import {
  checkUpload,
  uploadChunk,
  mergeChunks,
  type UploadScope,
} from "../../api/upload";
import { useToast } from "../../composables/useToast";

const props = defineProps<{
  knowledgeBaseId: number | null;
  documentId: number | null;
}>();
const emit = defineEmits<{
  (event: "knowledge-base-change", id: number): void;
  (event: "activated", filename: string, id: number | null): void;
  (event: "deleted", id: number): void;
  (event: "version-changed"): void;
}>();
const toast = useToast();
const libraries = ref<KnowledgeBase[]>([]),
  categories = ref<Category[]>([]),
  documents = ref<ManagedDocument[]>([]),
  tasks = ref<ProcessingTask[]>([]);
const editor = ref<InstanceType<typeof KnowledgeForm>>();
const dragging = ref(false),
  loading = ref(false),
  loaded = ref(false),
  loadError = ref("");
const historyBusy = ref(false);
let nextPollAt = 0;
const tasksExpanded = ref<boolean | null>(null);
async function removeTask(task: ProcessingTask) {
  if (
    historyBusy.value ||
    !(await confirmed(
      "从列表移除此任务记录？文档和索引不会删除，移除后不能从此列表重试。",
    ))
  )
    return;
  historyBusy.value = true;
  try {
    await api.dismissTask(task.id);
    await refresh();
  } catch {
    /* interceptor */
  } finally {
    historyBusy.value = false;
  }
}
async function clearHistory() {
  if (historyBusy.value) return;
  historyBusy.value = true;
  try {
    await api.clearCompletedTasks(props.knowledgeBaseId!);
    await refresh();
  } catch {
    /* interceptor */
  } finally {
    historyBusy.value = false;
  }
}
const attentionTasks = computed(
  () =>
    tasks.value.filter((t) => !["completed", "canceled"].includes(t.status))
      .length,
);
const showTasks = computed(
  () => tasksExpanded.value ?? attentionTasks.value > 0,
);
const visible = ref(false),
  keyword = ref(""),
  categoryFilter = ref<number>(),
  statusFilter = ref<string>(),
  page = ref(1),
  total = ref(0);
const currentLibrary = computed(() =>
  libraries.value.find((kb) => kb.id === props.knowledgeBaseId),
);
const selectedDocument = ref<ManagedDocument | null>(null);
const fileInput = ref<HTMLInputElement>(),
  uploading = ref(false),
  paused = ref(false),
  uploadPercent = ref(0),
  uploadLabel = ref("");
const replacing = ref<ManagedDocument | null>(null);
let uploadAbort: AbortController | undefined,
  timer: ReturnType<typeof setInterval> | undefined,
  requestSequence = 0,
  disposed = false;
let pendingActivation: { documentId: number; taskId: number } | null = null,
  polling = false;
const stageLabels: Record<string, string> = {
  queued: "排队中",
  parsing: "解析中",
  chunking: "切分中",
  embedding: "向量化中",
  indexing: "写入索引",
  completed: "已完成",
  failed: "失败",
  partial_failed: "部分失败",
  canceled: "已取消",
  rebuilding: "重建中",
  running: "执行中",
  retrying: "等待重试",
  waiting: "等待前置任务",
  summarizing: "逐章节总结中",
  retrieving: "检索资料中",
  generating: "生成回答中",
  superseded: "已有更新版本",
};
const kindLabels: Record<string, string> = {
  qa: "后台问答",
  index: "文档索引",
  rebuild: "全库重建",
  cleanup: "文档清理",
  "cleanup-library": "知识库清理",
  retire: "旧索引清理",
};
const isTerminal = (status: string) =>
  ["completed", "failed", "partial_failed", "canceled"].includes(status);
function stateLabel(doc: ManagedDocument) {
  if (doc.task && !isTerminal(doc.task.status))
    return (
      (stageLabels[doc.task.stage] || doc.task.stage) +
      (doc.task.total != null
        ? " " + doc.task.completed + "/" + doc.task.total
        : "")
    );
  return (
    (
      {
        pending: "待建立索引",
        queued: "排队中",
        ready: "已就绪",
        failed: "处理失败",
      } as Record<string, string>
    )[doc.status] || doc.status
  );
}
async function loadLibraries() {
  const result = await api.listKnowledgeBases();
  if (disposed) return;
  libraries.value = result;
  if (!props.knowledgeBaseId && result[0])
    emit("knowledge-base-change", result[0].id);
}
async function fetchDocuments(pollOnly = false) {
  const id = props.knowledgeBaseId;
  if (!id || !currentLibrary.value || disposed) return;
  const sequence = ++requestSequence;
  const [result, taskList, categoryList] = await Promise.all([
    api.listLibraryDocuments(id, {
      page: page.value,
      pageSize: 20,
      name: keyword.value || undefined,
      status: statusFilter.value || undefined,
      categoryId: categoryFilter.value,
    }),
    api.listTasks(id),
    pollOnly ? Promise.resolve(categories.value) : api.listCategories(id),
  ]);
  if (disposed || sequence !== requestSequence || id !== props.knowledgeBaseId)
    return;
  documents.value = result.items;
  total.value = result.total;
  tasks.value = taskList;
  categories.value = categoryList;
  if (props.documentId)
    selectedDocument.value =
      result.items.find((d) => d.id === props.documentId) ||
      selectedDocument.value;
  if (pendingActivation) {
    const pending = pendingActivation;
    const task = await api.getTask(pending.taskId);
    if (
      disposed ||
      pendingActivation !== pending ||
      id !== props.knowledgeBaseId
    )
      return;
    if (task.status === "completed") {
      const doc = await api.getDocument(pending.documentId);
      if (
        pendingActivation === pending &&
        doc.knowledgeBaseId === id &&
        doc.activeIndexRevisionId &&
        doc.latestTaskId === pending.taskId
      ) {
        activate(doc);
        pendingActivation = null;
        emit("version-changed");
      }
    } else if (isTerminal(task.status)) pendingActivation = null;
  }
}
async function refresh() {
  nextPollAt = 0;
  await refreshData();
}
async function refreshData(pollOnly = false) {
  const id = props.knowledgeBaseId;
  loading.value = true;
  try {
    await fetchDocuments(pollOnly);
    if (id === props.knowledgeBaseId) {
      loaded.value = true;
      loadError.value = "";
    }
  } catch {
    if (id === props.knowledgeBaseId)
      loadError.value = "暂时无法更新文档，请重试。";
  } finally {
    loading.value = false;
  }
}
function libraryCommand(command: string) {
  if (command === "edit") editLibrary();
  else if (command === "rebuild") void rebuildLibrary();
  else if (command === "delete") void deleteLibrary();
}
function documentAction(command: string, doc: ManagedDocument) {
  if (command === "activate") activate(doc);
  else if (command === "replace") chooseFile(doc);
  else if (command === "rename") renameDocument(doc);
  else if (command === "reindex") void run(() => api.reindexDocument(doc.id));
  else if (command === "delete") void deleteDocument(doc);
}
function editName(
  title: string,
  initial: string,
  save: (name: string) => Promise<unknown>,
) {
  editor.value?.open({
    title,
    name: initial,
    onSave: async (name) => {
      await save(name);
      await refresh();
    },
  });
}
async function run(action: () => Promise<unknown>) {
  try {
    await action();
    await loadLibraries();
    await refresh();
  } catch {
    /* API interceptor displays the error. */
  }
}
async function retryProcessingTask(task: ProcessingTask) {
  const libraryId = props.knowledgeBaseId;
  await run(async () => {
    await api.retryTask(task.id);
    if (
      task.kind === "index" &&
      task.documentId &&
      props.knowledgeBaseId === libraryId
    )
      pendingActivation = { documentId: task.documentId, taskId: task.id };
  });
}
async function confirmed(message: string) {
  try {
    await ElMessageBox.confirm(message, "确认操作", {
      type: "warning",
      customClass: "knowledge-theme knowledge-confirm",
      confirmButtonText: "确认",
      cancelButtonText: "取消",
    });
    return true;
  } catch {
    return false;
  }
}
function changeLibrary(id: number) {
  emit("knowledge-base-change", id);
}
function createLibrary() {
  editor.value?.open({
    title: "新建知识库",
    onSave: async (name) => {
      const kb = await api.createKnowledgeBase(name);
      await loadLibraries();
      emit("knowledge-base-change", kb.id);
    },
  });
}
function editLibrary() {
  const kb = currentLibrary.value;
  if (!kb) return;
  editor.value?.open({
    title: "编辑知识库",
    name: kb.name,
    description: kb.description || "",
    onSave: async (name, description) => {
      await api.updateKnowledgeBase(kb.id, name, description);
      await loadLibraries();
    },
  });
}
async function deleteLibrary() {
  if (
    !(await confirmed(
      "删除知识库及其文档？关联工作台产物会删除，聊天记录保留为只读。",
    ))
  )
    return;
  await run(async () => {
    await api.deleteKnowledgeBase(props.knowledgeBaseId!);
    emit("activated", "", null);
    visible.value = false;
    const result = await api.listKnowledgeBases();
    libraries.value = result;
    if (result[0]) emit("knowledge-base-change", result[0].id);
    emit("version-changed");
  });
}
async function rebuildLibrary() {
  if (
    await confirmed(
      "重新构建当前知识库的全部索引？处理期间仍可使用旧索引问答。",
    )
  )
    await run(() => api.reindexKnowledgeBase(props.knowledgeBaseId!));
}
function addCategory() {
  const id = props.knowledgeBaseId!;
  editName("添加分类", "", (name) => api.createCategory(id, name));
}
function renameCategory(category: Category) {
  const id = props.knowledgeBaseId!;
  editName("修改分类", category.name, (name) =>
    api.updateCategory(id, category.id, name),
  );
}
async function removeCategory(category: Category) {
  if (await confirmed("删除分类后，其中的文档归入未分类。"))
    await run(() => api.deleteCategory(props.knowledgeBaseId!, category.id));
}
async function classify(doc: ManagedDocument, categoryId?: number) {
  await run(() =>
    api.updateDocument(doc.id, { categoryId: categoryId || null }),
  );
}
function renameDocument(doc: ManagedDocument) {
  editName("重命名文档（保留扩展名）", doc.filename, (name) =>
    api.updateDocument(doc.id, { filename: name }),
  );
}
function activate(doc: ManagedDocument) {
  selectedDocument.value = doc;
  emit("activated", doc.filename, doc.id);
  toast.success("已选择工作台来源");
}
function clearSource() {
  pendingActivation = null;
  selectedDocument.value = null;
  emit("activated", "", null);
}
async function deleteDocument(doc: ManagedDocument) {
  if (
    !(await confirmed(
      "删除此文档及关联摘要、闪卡和思维导图？历史聊天引用会保留。",
    ))
  )
    return;
  await run(async () => {
    await api.removeDocument(doc.id);
    emit("deleted", doc.id);
    if (props.documentId === doc.id) {
      selectedDocument.value = null;
      emit("activated", "", null);
    }
  });
}
function chooseFile(doc?: ManagedDocument) {
  replacing.value = doc || null;
  fileInput.value?.click();
}
function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void sendFile(file);
}
function dropFile(event: DragEvent) {
  if (!uploading.value && !currentLibrary.value?.rebuildTaskId) {
    replacing.value = null;
    const file = event.dataTransfer?.files[0];
    if (file) void sendFile(file);
  }
}
function cancelUpload() {
  uploadAbort?.abort();
  paused.value = false;
}
function fileMd5(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../../workers/md5.worker.ts", import.meta.url),
      { type: "module" },
    );
    const abort = () => {
      worker.terminate();
      reject(new DOMException("已取消", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    const finish = () => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress")
        uploadLabel.value = "计算文件指纹 " + data.percent + "%";
      if (data.type === "done") {
        finish();
        resolve(data.md5);
      }
      if (data.type === "error") {
        finish();
        reject(new Error(data.message));
      }
    };
    worker.onerror = () => {
      finish();
      reject(new Error("文件指纹计算失败"));
    };
    worker.postMessage({ file, chunkSize: 4 * 1024 * 1024 });
  });
}
async function sendFile(file: File) {
  if (
    uploading.value ||
    !props.knowledgeBaseId ||
    !currentLibrary.value ||
    currentLibrary.value.rebuildTaskId
  )
    return;
  if (
    !/\.(pdf|md)$/i.test(file.name) ||
    !file.size ||
    file.size > 128 * 1024 * 1024
  ) {
    toast.warning("请选择不超过 128 MiB 的非空 PDF 或 Markdown");
    return;
  }
  const kbId = props.knowledgeBaseId,
    target = replacing.value;
  uploading.value = true;
  paused.value = false;
  uploadPercent.value = 0;
  uploadAbort = new AbortController();
  const signal = uploadAbort.signal;
  try {
    const md5 = await fileMd5(file, signal);
    const storageKey =
      "rag-upload/" +
      localStorage.getItem("username") +
      "/" +
      kbId +
      "/" +
      (target?.id || 0) +
      "/" +
      md5;
    const uploadId = localStorage.getItem(storageKey) || crypto.randomUUID();
    localStorage.setItem(storageKey, uploadId);
    const scope: UploadScope = {
      knowledgeBaseId: kbId,
      uploadId,
      ...(target ? { documentId: target.id } : {}),
      ...(categoryFilter.value ? { categoryId: categoryFilter.value } : {}),
    };
    const check = await checkUpload(md5, file.name, scope);
    let accepted: AcceptedDocument;
    if (check.uploaded && check.documentId && check.taskId)
      accepted = {
        documentId: check.documentId,
        taskId: check.taskId,
        knowledgeBaseId: kbId,
        filename: file.name,
      };
    else {
      const chunkSize = 4 * 1024 * 1024,
        count = Math.ceil(file.size / chunkSize),
        uploaded = new Set(check.uploadedChunks || []);
      const pending = Array.from({ length: count }, (_, index) => index).filter(
        (index) => !uploaded.has(index),
      );
      let done = uploaded.size,
        cursor = 0;
      const next = async () => {
        while (cursor < pending.length) {
          if (signal.aborted) throw new DOMException("已取消", "AbortError");
          while (paused.value && !signal.aborted)
            await new Promise((resolve) => setTimeout(resolve, 150));
          if (signal.aborted) throw new DOMException("已取消", "AbortError");
          const index = pending[cursor++];
          await uploadChunk(
            file.slice(index * chunkSize, (index + 1) * chunkSize),
            md5,
            index,
            count,
            file.name,
            scope,
            signal,
          );
          done++;
          uploadPercent.value = Math.round((done / count) * 100);
          uploadLabel.value =
            (target ? "替换上传：" : "上传：") +
            file.name +
            " " +
            done +
            "/" +
            count;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, pending.length) }, next),
      );
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      uploadLabel.value = "正在合并文件并创建后台任务";
      accepted = await mergeChunks(md5, file.name, count, scope);
    }
    localStorage.removeItem(storageKey);
    if (signal.aborted || props.knowledgeBaseId !== kbId) return;
    pendingActivation = {
      documentId: accepted.documentId,
      taskId: accepted.taskId,
    };
    page.value = 1;
    toast.success("文件已接收，后台正在解析和向量化");
    await refresh();
  } catch (error) {
    const canceled = signal.aborted;
    uploadAbort?.abort();
    if (!canceled && error instanceof Error) toast.error(error.message);
  } finally {
    uploading.value = false;
    replacing.value = null;
  }
}
watch(
  () => props.knowledgeBaseId,
  () => {
    cancelUpload();
    nextPollAt = 0;
    requestSequence++;
    pendingActivation = null;
    loaded.value = false;
    loadError.value = "";
    tasksExpanded.value = null;
    page.value = 1;
    categoryFilter.value = undefined;
    statusFilter.value = undefined;
    keyword.value = "";
    categories.value = [];
    documents.value = [];
    tasks.value = [];
    selectedDocument.value = null;
    void refresh().catch(() => undefined);
  },
);
watch(
  () => props.documentId,
  (id) => {
    if (!id) selectedDocument.value = null;
  },
);
watch([keyword, categoryFilter, statusFilter], () => {
  page.value = 1;
  void refresh().catch(() => undefined);
});
watch(visible, (open) => {
  if (open) {
    nextPollAt = 0;
    void refresh();
  }
});
function onPageVisible() {
  if (!document.hidden && (visible.value || pendingActivation)) {
    nextPollAt = 0;
    void refreshData(true);
  }
}
onMounted(async () => {
  document.addEventListener("visibilitychange", onPageVisible);
  try {
    await loadLibraries();
    await refresh();
  } catch {
    /* interceptor */
  }
  timer = setInterval(async () => {
    if (
      polling ||
      document.hidden ||
      (!visible.value && !pendingActivation && !uploading.value) ||
      Date.now() < nextPollAt ||
      (!loadError.value &&
        !pendingActivation &&
        !uploading.value &&
        !currentLibrary.value?.rebuildTaskId &&
        !tasks.value.some((t) => !isTerminal(t.status)) &&
        !documents.value.some((d) => d.task && !isTerminal(d.task.status))) ||
      disposed ||
      !currentLibrary.value ||
      !localStorage.getItem("token")
    )
      return;
    polling = true;
    try {
      await refreshData(true);
      const active = tasks.value.filter((t) => !isTerminal(t.status));
      const onlyDelayed =
        !pendingActivation &&
        !uploading.value &&
        active.length &&
        active.every(
          (t) => t.waitingUntil && Date.parse(t.waitingUntil) > Date.now(),
        );
      nextPollAt = onlyDelayed
        ? Math.min(
            Date.now() + 30000,
            ...active.map((t) => Date.parse(t.waitingUntil!)),
          )
        : 0;
      if (
        currentLibrary.value?.rebuildTaskId ||
        tasks.value.some((t) => t.kind === "rebuild" && !isTerminal(t.status))
      )
        await loadLibraries();
    } catch {
      /* next poll can recover */
    } finally {
      polling = false;
    }
  }, 2000);
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onPageVisible);
  disposed = true;
  requestSequence++;
  cancelUpload();
  if (timer) clearInterval(timer);
});
</script>

<style lang="scss">
@use "./Knowledge.scss";
</style>
