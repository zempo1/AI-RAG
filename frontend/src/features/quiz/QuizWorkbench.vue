<template>
  <div class="quiz-workspace">
    <GenerateSection
      :file-name="filename"
      :icon="MagicStick"
      button-text="生成智能测验"
      :disabled="!documentId || !filename || generating || documentReady === false"
      :loading="generating"
      @generate="dialogVisible = true"
    />
    <p
      v-if="documentId && documentReady === false"
      class="quiz-validation quiz-source-notice"
      role="status"
    >
      文档尚未就绪，处理完成后即可生成。
    </p>
    <section v-if="visibleTasks.length" class="quiz-task-list" aria-label="测验生成任务">
      <article v-for="task in visibleTasks" :key="task.id" class="quiz-task">
        <div class="quiz-task-heading">
          <span class="quiz-status-dot" :class="{ failed: task.status === 'failed' }"></span
          ><strong>{{ task.status === "failed" ? "生成失败" : stageLabel(task.stage) }}</strong
          ><span v-if="task.total && !terminal(task.status)"
            >{{ task.completed }}/{{ task.total }}</span
          >
        </div>
        <p v-if="task.status === 'failed'">{{ task.error || "生成未完成，请稍后重试" }}</p>
        <p v-else>{{ task.filename || filename }} · 可离开页面，后台将继续生成</p>
        <div class="quiz-task-actions">
          <button v-if="!terminal(task.status)" @click="taskAction(task, true)">取消生成</button
          ><button v-else-if="task.retryable" @click="taskAction(task, false)">重试生成</button>
        </div>
      </article>
    </section>
    <section class="quiz-history">
      <div class="quiz-history-heading">
        <h3>我的测验</h3>
        <span>{{ items.length }} 套</span
        ><button aria-label="刷新测验列表" @click="loadWorkspace">
          <el-icon><Refresh /></el-icon>
        </button>
      </div>
      <p v-if="loading" class="quiz-muted" role="status">正在读取测验…</p>
      <div v-else-if="failure" class="quiz-list-error" role="alert">
        <p>{{ failure }}</p>
        <button @click="loadWorkspace">重新加载</button>
      </div>
      <div v-else-if="!items.length" class="quiz-empty">
        <el-icon><Collection /></el-icon><strong>第一套测验，等你开始</strong>
        <p>生成后，题目和练习进度会保存在这里。</p>
      </div>
      <article v-for="item in items" :key="item.id" class="quiz-history-card">
        <div class="quiz-card-top">
          <span class="quiz-card-count">{{ item.questionCount }} 道题</span
          ><button :aria-label="'删除测验：' + item.title" @click="remove(item)">
            <el-icon><Delete /></el-icon>
          </button>
        </div>
        <button class="quiz-card-title" @click="emit('open', item.id, false)">
          {{ item.title }}
        </button>
        <p class="quiz-card-source" :title="item.filename">{{ item.filename }}</p>
        <div class="quiz-card-meta">
          <span v-if="item.singleCount">单选 {{ item.singleCount }}</span
          ><span v-if="item.multipleCount">多选 {{ item.multipleCount }}</span
          ><span>{{ formatDate(item.createdAt) }}</span>
        </div>
        <p v-if="item.sourceOutdated" class="quiz-outdated">来源已更新 · 历史版本</p>
        <div class="quiz-card-bottom">
          <span v-if="item.latestAttempt?.status === 'completed'" class="quiz-grade"
            >{{ item.latestAttempt.score }}<small> 分</small></span
          ><span v-else class="quiz-muted">{{
            item.latestAttempt
              ? `已答 ${item.latestAttempt.answeredCount}/${item.questionCount}`
              : "尚未开始"
          }}</span>
          <div>
            <button v-if="item.latestAttempt" @click="emit('open', item.id, true)">重做</button
            ><button class="quiz-card-continue" @click="emit('open', item.id, false)">
              {{
                item.latestAttempt?.status === "completed"
                  ? "查看结果"
                  : item.latestAttempt
                    ? "继续练习"
                    : "开始练习"
              }}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </article>
    </section>
    <el-dialog
      v-model="dialogVisible"
      title="生成智能测验"
      width="460px"
      class="quiz-config-dialog"
      align-center
      :close-on-click-modal="false"
      destroy-on-close
    >
      <p class="quiz-dialog-subtitle">选好题目，让每一次练习都有方向。</p>
      <div class="quiz-dialog-source">
        <el-icon><Document /></el-icon><span>{{ filename }}</span>
      </div>
      <el-form label-position="top" @submit.prevent="generate">
        <el-form-item label="题目数量"
          ><el-input-number
            v-model="total"
            :min="1"
            :max="20"
            :precision="0"
            controls-position="right"
            aria-label="题目数量"
          /><span class="quiz-field-hint">每套 1～20 道题</span></el-form-item
        >
        <el-form-item label="题目类型"
          ><el-checkbox-group v-model="types" aria-label="题目类型"
            ><el-checkbox label="SINGLE">单选题</el-checkbox
            ><el-checkbox label="MULTIPLE">多选题</el-checkbox></el-checkbox-group
          ></el-form-item
        >
        <div v-if="types.length === 2" class="quiz-ratio-field">
          <div>
            <label for="quiz-ratio">题型配比</label
            ><span
              >{{ Math.round(((counts?.singleCount || 0) / total) * 100) }}% /
              {{ Math.round(((counts?.multipleCount || 0) / total) * 100) }}%</span
            >
          </div>
          <el-slider
            id="quiz-ratio"
            :model-value="counts?.singleCount || 1"
            :min="1"
            :max="Math.max(1, total - 1)"
            :step="1"
            :show-tooltip="false"
            aria-label="单选题数量"
            @update:model-value="ratio = Number($event) / total"
          />
          <p>
            单选 <strong>{{ counts?.singleCount || 0 }}</strong> 道 <span>／</span> 多选
            <strong>{{ counts?.multipleCount || 0 }}</strong> 道
          </p>
        </div>
        <p v-if="configError" class="quiz-validation" role="alert">{{ configError }}</p>
        <p class="quiz-config-note">
          单选点击即可判题，多选提交后判题。题目、答案与解析均依据所选文档生成。
        </p>
      </el-form>
      <template #footer
        ><el-button @click="dialogVisible = false">取消</el-button
        ><el-button
          type="primary"
          :loading="generating"
          :disabled="!!configError || !documentId"
          @click="generate"
          >开始生成</el-button
        ></template
      >
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  Document,
  MagicStick,
  Refresh,
  Collection,
  Delete,
} from "@element-plus/icons-vue";
import {
  deleteQuiz,
  generateQuiz,
  getQuizWorkspace,
  type Quiz,
  type QuizTask,
} from "../../api/quizzes";
import { getTask, retryTask } from "../../api/knowledge-bases";
import request from "../../utils/request";
import { useToast } from "../../composables/useToast";
import { useConfirm } from "../../composables/useConfirm";
import { resolveQuizCounts } from "./quiz-state";
import GenerateSection from "../workbench/components/GenerateSection/GenerateSection.vue";
const props = defineProps<{
  documentId: number | null;
  documentReady?: boolean;
  filename: string;
  knowledgeBaseId?: number | null;
  active?: boolean;
}>();
const emit = defineEmits<{ (e: "open", id: number, restart?: boolean): void }>();
const toast = useToast(),
  confirm = useConfirm();
const items = ref<Quiz[]>([]),
  tasks = ref<QuizTask[]>([]),
  loading = ref(false),
  failure = ref(""),
  dialogVisible = ref(false),
  generating = ref(false);
const total = ref(10),
  types = ref(["SINGLE", "MULTIPLE"]),
  ratio = ref(0.5);
const configError = computed(() => {
  try {
    resolveQuizCounts(total.value, types.value, ratio.value);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
});
const counts = computed(() =>
  configError.value ? null : resolveQuizCounts(total.value, types.value, ratio.value),
);
const terminal = (status: string) =>
  ["completed", "failed", "canceled", "partial_failed"].includes(status);
const isActive = () => props.active !== false;
const visibleTasks = computed(() =>
  tasks.value.filter((task) => !terminal(task.status) || task.status === "failed"),
);
const stageLabel = (stage: string) =>
  ({
    queued: "等待生成",
    reading: "读取来源文档",
    generating: "正在生成题目",
    validating: "核对题目与答案",
    retrying: "正在重试",
  })[stage] || "正在生成测验";
const formatDate = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
let revision = 0,
  watchedTask: number | null = null,
  requestId = crypto.randomUUID(),
  polling = false,
  abort: AbortController | undefined;
async function loadWorkspace() {
  const kb = props.knowledgeBaseId;
  if (!kb) {
    items.value = [];
    tasks.value = [];
    return;
  }
  const current = ++revision;
  abort?.abort();
  abort = new AbortController();
  loading.value = true;
  failure.value = "";
  try {
    const data = await getQuizWorkspace(kb, abort.signal);
    if (current !== revision) return;
    items.value = data.items || [];
    tasks.value = data.generationTasks || [];
  } catch (error) {
    if (current === revision && !abort?.signal.aborted) failure.value = "测验列表读取失败，请重试";
  } finally {
    if (current === revision) loading.value = false;
  }
}
async function generate() {
  if (!props.documentId || props.documentReady === false || !counts.value || generating.value)
    return;
  const kb = props.knowledgeBaseId,
    doc = props.documentId;
  generating.value = true;
  try {
    const task = await generateQuiz({ documentId: doc, ...counts.value, requestId });
    if (kb !== props.knowledgeBaseId || doc !== props.documentId) return;
    watchedTask = task.taskId;
    requestId = crypto.randomUUID();
    dialogVisible.value = false;
    await loadWorkspace();
    toast.success("测验已开始生成");
  } catch {
    toast.error("提交生成失败，请重试");
  } finally {
    generating.value = false;
  }
}
async function taskAction(task: QuizTask, cancel: boolean) {
  try {
    if (cancel) await request.post(`/api/tasks/${task.id}/cancel`);
    else {
      await retryTask(task.id);
      watchedTask = task.id;
    }
    await loadWorkspace();
  } catch {
    toast.error("任务操作失败，请重试");
  }
}
async function remove(item: Quiz) {
  if (!(await confirm.danger("删除此测验及其练习记录？", "删除测验"))) return;
  try {
    await deleteQuiz(item.id);
    await loadWorkspace();
    toast.success("测验已删除");
  } catch {
    toast.error("删除失败，请重试");
  }
}
watch(
  () => props.knowledgeBaseId,
  () => {
    revision++;
    watchedTask = null;
    requestId = crypto.randomUUID();
    items.value = [];
    tasks.value = [];
    dialogVisible.value = false;
    void loadWorkspace();
  },
  { immediate: true },
);
watch(
  () => props.documentId,
  () => {
    requestId = crypto.randomUUID();
    watchedTask = null;
    dialogVisible.value = false;
  },
);
watch(
  [total, types, ratio],
  () => {
    requestId = crypto.randomUUID();
  },
  { deep: true },
);
watch(
  () => props.active,
  (active) => {
    if (active !== false) void loadWorkspace();
  },
);
const timer = setInterval(async () => {
  if (polling || !isActive() || document.hidden) return;
  const active = tasks.value.filter((task) => !terminal(task.status));
  if (!active.length) return;
  polling = true;
  const current = revision;
  try {
    const results = await Promise.all(
      active.map((task) => getTask(task.id, true) as Promise<QuizTask>),
    );
    if (current !== revision) return;
    for (const result of results) {
      const index = tasks.value.findIndex((task) => task.id === result.id);
      if (index >= 0) tasks.value[index] = result;
    }
    const finished = results.find(
      (task) => task.id === watchedTask && task.status === "completed" && task.quizResult,
    );
    if (results.some((task) => terminal(task.status))) await loadWorkspace();
    if (finished && watchedTask === finished.id && isActive()) {
      watchedTask = null;
      emit("open", finished.quizResult!.quizId, false);
    }
  } catch {
    /* Keep the durable task and reconnect on the next tick. */
  } finally {
    polling = false;
  }
}, 2000);
onBeforeUnmount(() => {
  revision++;
  abort?.abort();
  clearInterval(timer);
});
defineExpose({ refresh: loadWorkspace });
</script>
<style lang="scss" src="./quiz-workbench.scss"></style>
