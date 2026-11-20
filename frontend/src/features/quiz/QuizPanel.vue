<template>
  <section
    ref="panel"
    class="quiz-panel"
    :class="{ 'is-fullscreen': fullscreen }"
    :role="fullscreen ? 'dialog' : 'region'"
    :aria-modal="fullscreen || undefined"
    aria-label="智能测验答题面板"
    tabindex="-1"
    @keydown="onPanelKey"
  >
    <header class="quiz-panel-header">
      <div class="quiz-panel-heading">
        <span class="quiz-eyebrow"
          >智能测验 <span aria-hidden="true">/</span>
          {{ attempt?.status === "completed" ? "已完成" : "练习中" }}</span
        >
        <h2>{{ attempt?.quiz.title || "智能测验" }}</h2>
        <button v-if="attempt" class="quiz-source-link" @click="openSource()">
          <el-icon><Document /></el-icon>{{ attempt.quiz.filename }}
        </button>
      </div>
      <div class="quiz-panel-actions">
        <button
          ref="fullscreenButton"
          type="button"
          :aria-label="fullscreen ? '退出测验全屏' : '全屏展示测验'"
          :title="fullscreen ? '退出全屏' : '全屏'"
          @click="toggleFullscreen"
        >
          <el-icon><FullScreen /></el-icon></button
        ><button type="button" aria-label="关闭测验" title="返回工作台" @click="close">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </header>
    <div
      v-if="attempt?.quiz.attempts && attempt.quiz.attempts.length > 1"
      class="quiz-attempt-history"
    >
      <label for="quiz-attempt-history">练习记录</label>
      <select
        id="quiz-attempt-history"
        :value="attempt.id"
        :disabled="loading || saving"
        @change="switchAttempt(Number(($event.target as HTMLSelectElement).value))"
      >
        <option
          v-for="(record, index) in attempt.quiz.attempts"
          :key="record.id"
          :value="record.id"
        >
          第 {{ attempt.quiz.attempts.length - index }} 次 ·
          {{
            record.status === "completed"
              ? record.score + " 分"
              : "已答 " + record.answeredCount + "/" + record.totalCount
          }}
          · {{ new Date(record.createdAt).toLocaleDateString("zh-CN") }}
        </option>
      </select>
    </div>
    <p v-if="attempt?.quiz.sourceOutdated" class="quiz-panel-notice">
      此测验基于历史版本。你可以继续练习和查看解析；AI 讲解需重新生成测验。
    </p>
    <div v-if="loading" class="quiz-panel-status" role="status">
      <span class="quiz-loading-ring"></span>正在准备你的测验…
    </div>
    <div v-else-if="loadFailure" class="quiz-panel-status" role="alert">
      <h3>暂时无法打开测验</h3>
      <p>{{ loadFailure }}</p>
      <button class="quiz-panel-primary" @click="load">重新加载</button>
    </div>
    <template v-else-if="attempt && question">
      <div class="quiz-progress-heading">
        <span
          >已完成 <strong>{{ attempt.answeredCount }}</strong> / {{ attempt.totalCount }}</span
        ><span class="quiz-save-state" :class="{ 'has-error': !!saveFailure }" role="status">{{
          saveFailure ? "尚未保存" : saving ? "正在保存…" : "进度已保存"
        }}</span>
      </div>
      <div
        class="quiz-progress-track"
        role="progressbar"
        aria-label="测验答题进度"
        :aria-valuenow="attempt.answeredCount"
        :aria-valuemin="0"
        :aria-valuemax="attempt.totalCount"
      >
        <span
          :style="{ transform: `scaleX(${attempt.answeredCount / attempt.totalCount})` }"
        ></span>
      </div>
      <div v-if="saveFailure" class="quiz-save-error" role="alert">
        <span>{{ saveFailure }}，选择仍保留在当前页面。</span
        ><button @click="retrySave">重试保存</button>
      </div>
      <div class="quiz-panel-scroll">
        <section v-if="showResults" class="quiz-results">
          <div class="quiz-result-icon">
            <el-icon><CircleCheck /></el-icon>
          </div>
          <span class="quiz-eyebrow">本次练习已完成</span>
          <h3>每一次练习，都更近一步</h3>
          <p>回看解析，把疑问变成理解。</p>
          <div class="quiz-result-score">{{ attempt.score }}<span>分</span></div>
          <div class="quiz-result-metrics">
            <div>
              <strong>{{ attempt.correctCount }} / {{ attempt.totalCount }}</strong
              ><span>答对题目</span>
            </div>
            <div>
              <strong>{{ attempt.score }}%</strong><span>正确率</span>
            </div>
          </div>
          <div v-if="wrongQuestions.length" class="quiz-result-wrong">
            <h4>这些知识点，值得再看一遍</h4>
            <button
              v-for="item in wrongQuestions"
              :key="item.question.id"
              @click="navigate(item.index)"
            >
              <span>第 {{ item.index + 1 }} 题</span>
              <span class="quiz-result-wrong-stem">{{ item.question.stem }}</span>
              <span aria-hidden="true">→</span>
            </button>
          </div>
          <div class="quiz-result-buttons">
            <button @click="navigate(0)">查看全部解析</button
            ><button class="quiz-restart" @click="restartPractice">
              <el-icon><RefreshRight /></el-icon>重新练习
            </button>
          </div>
        </section>
        <article v-else class="quiz-question" :key="question.id">
          <div class="quiz-question-meta">
            <span class="quiz-type-badge">{{
              question.type === "SINGLE" ? "单选题" : "多选题"
            }}</span
            ><span
              >{{ currentIndex + 1 }} <span class="quiz-meta-slash">/</span>
              {{ attempt.totalCount }}</span
            >
          </div>
          <h3 class="quiz-question-stem">{{ question.stem }}</h3>
          <p class="quiz-answer-hint">
            {{
              answer?.submitted
                ? "本题已提交，可查看下方解析"
                : question.type === "SINGLE"
                  ? "选择一个最合适的答案"
                  : "请选择所有正确答案，选好后提交"
            }}
          </p>
          <div
            class="quiz-options"
            :role="question.type === 'SINGLE' ? 'radiogroup' : 'group'"
            aria-label="题目选项"
          >
            <button
              v-for="option in question.options"
              :key="option.id"
              type="button"
              class="quiz-option"
              :class="{
                selected: selected.includes(option.id),
                correct: answer?.submitted && question.correctOptionIds?.includes(option.id),
                incorrect:
                  answer?.submitted &&
                  selected.includes(option.id) &&
                  !question.correctOptionIds?.includes(option.id),
              }"
              :role="question.type === 'SINGLE' ? 'radio' : 'checkbox'"
              :aria-checked="selected.includes(option.id)"
              :disabled="locked"
              @click="choose(option.id)"
            >
              <span class="quiz-option-letter">{{ option.id }}</span
              ><span class="quiz-option-content"
                ><span class="quiz-option-text"
                  >{{ option.text }} <span
                    v-if="answer?.submitted && question.correctOptionIds?.includes(option.id)"
                    class="quiz-option-result"
                    ><el-icon><Check /></el-icon>正确答案{{
                      selected.includes(option.id) ? " · 你的选择" : ""
                    }}</span
                  ><span
                    v-else-if="answer?.submitted && selected.includes(option.id)"
                    class="quiz-option-result"
                    ><el-icon><Close /></el-icon>你的选择</span
                  ></span
                ><span v-if="answer?.submitted" class="quiz-option-explanation">{{
                  question.optionExplanations?.[option.id]
                }}</span></span
              ><span v-if="!answer?.submitted" class="quiz-option-mark" aria-hidden="true">{{
                selected.includes(option.id) ? "✓" : ""
              }}</span>
            </button>
          </div>
          <section
            v-if="answer?.submitted"
            class="quiz-feedback"
            :class="{ incorrect: !answer.isCorrect }"
            aria-label="本题解析"
          >
            <h4>
              <el-icon><CircleCheck v-if="answer.isCorrect" /><Warning v-else /></el-icon
              >{{ answer.isCorrect ? "回答正确！" : "再巩固一下这个知识点" }}
            </h4>
            <p>{{ question.explanation }}</p>
            <div class="quiz-explanation-actions">
              <button
                class="quiz-explain"
                :disabled="chatBusy || attempt.quiz.sourceOutdated || !!saveFailure"
                @click="explain"
              >
                <el-icon><ChatDotRound /></el-icon
                >{{ chatBusy ? "等待当前回答完成" : "解释" }}</button
              ><span>让 AI 结合原文深入讲解</span>
            </div>
          </section>
          <button
            v-else-if="question.type === 'MULTIPLE'"
            class="quiz-panel-primary quiz-submit-answer"
            :disabled="!selected.length || locked || !!saveFailure"
            @click="submitMultiple"
          >
            提交答案
          </button>
          <div v-if="question.evidence?.length" class="quiz-question-sources">
            <span>依据资料</span
            ><button
              v-for="(source, index) in question.evidence"
              :key="source.chunkId + ':' + index"
              @click="openSource(index)"
            >
              <el-icon><Document /></el-icon
              >{{
                source.location?.page
                  ? "第 " + source.location.page + " 页"
                  : source.location?.heading || "查看原文"
              }}
            </button>
          </div>
        </article>
      </div>
      <footer class="quiz-panel-footer">
        <div class="quiz-number-nav" aria-label="题号导航">
          <button
            v-for="(item, index) in attempt.questions"
            :key="item.id"
            :class="{
              current: !showResults && index === currentIndex,
              answered: attempt.answers[item.id]?.submitted,
              wrong: attempt.answers[item.id]?.submitted && !attempt.answers[item.id]?.isCorrect,
            }"
            :aria-label="`第 ${index + 1} 题${attempt.answers[item.id]?.submitted ? '，已作答' : ''}`"
            :aria-current="!showResults && index === currentIndex ? 'step' : undefined"
            @click="navigate(index)"
          >
            {{ index + 1 }}
          </button>
        </div>
        <div class="quiz-bottom-actions">
          <button
            :disabled="currentIndex === 0 && !showResults"
            @click="navigate(Math.max(0, currentIndex - 1))"
          >
            <span aria-hidden="true">←</span> 上一题</button
          ><button
            v-if="attempt.status === 'completed' && !showResults"
            @click="showResults = true"
          >
            查看成绩</button
          ><button
            v-else-if="currentIndex < attempt.totalCount - 1 && !showResults"
            class="quiz-next"
            @click="navigate(currentIndex + 1)"
          >
            下一题 <span aria-hidden="true">→</span></button
          ><span v-else-if="!showResults" class="quiz-last-hint">{{
            attempt.status === "completed" ? "已完成全部题目" : "完成剩余题目后查看成绩"
          }}</span>
        </div>
      </footer>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, nextTick, watch, onMounted, onBeforeUnmount } from "vue";
import {
  Document,
  FullScreen,
  Close,
  CircleCheck,
  RefreshRight,
  Check,
  Warning,
  ChatDotRound,
} from "@element-plus/icons-vue";
import {
  createQuizAttempt,
  getQuiz,
  getQuizAttempt,
  saveQuizProgress,
  type QuizAttempt,
  type QuizProgress,
  type QuizExplainRequest,
} from "../../api/quizzes";
import type { DocumentTarget } from "../reader/types";
import type { Citation } from "../../api/knowledge-bases";
import { buildQuizExplanation } from "./quiz-state";
const props = defineProps<{ quizId: number; restart?: boolean; chatBusy?: boolean }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "explain", payload: QuizExplainRequest): void;
  (e: "open-source", target: DocumentTarget): void;
  (e: "fullscreen-change", value: boolean): void;
  (e: "updated"): void;
}>();
const panel = ref<HTMLElement>(),
  fullscreenButton = ref<HTMLButtonElement>();
const attempt = ref<QuizAttempt>(),
  loading = ref(false),
  loadFailure = ref(""),
  saving = ref(false),
  saveFailure = ref(""),
  fullscreen = ref(false),
  showResults = ref(false),
  currentIndex = ref(0);
const selections = ref<Record<string, string[]>>({}),
  pendingSubmissions = ref(new Set<string>());
const question = computed(() => attempt.value?.questions[currentIndex.value]);
const answer = computed(() =>
  question.value ? attempt.value?.answers[question.value.id] : undefined,
);
const selected = computed(() => (question.value ? selections.value[question.value.id] || [] : []));
const locked = computed(
  () =>
    !!answer.value?.submitted ||
    (!!question.value && pendingSubmissions.value.has(question.value.id)),
);
const wrongQuestions = computed(
  () =>
    attempt.value?.questions
      .map((question, index) => ({ question, index }))
      .filter(
        (item) =>
          attempt.value?.answers[item.question.id]?.submitted &&
          !attempt.value.answers[item.question.id]?.isCorrect,
      ) || [],
);
const pending: QuizProgress[] = [];
let savePromise: Promise<boolean> | null = null,
  epoch = 0,
  newAttemptId = crypto.randomUUID();
function hydrate(value: QuizAttempt) {
  attempt.value = value;
  currentIndex.value = value.currentIndex;
  selections.value = Object.fromEntries(
    Object.entries(value.answers).map(([id, answer]) => [id, [...answer.selectedOptionIds]]),
  );
  showResults.value = value.status === "completed";
}
async function load() {
  const version = ++epoch;
  loading.value = true;
  loadFailure.value = "";
  try {
    const quiz = await getQuiz(props.quizId);
    if (version !== epoch) return;
    const data =
      !props.restart && quiz.latestAttempt
        ? await getQuizAttempt(quiz.latestAttempt.id)
        : await createQuizAttempt(props.quizId, newAttemptId);
    if (version === epoch) hydrate(data);
  } catch (error) {
    if (version === epoch) loadFailure.value = (error as Error).message || "读取失败，请重试";
  } finally {
    if (version === epoch) loading.value = false;
  }
}
function enqueue(progress: QuizProgress) {
  pending.push(progress);
  if (!saveFailure.value) void flush();
}
function flush(): Promise<boolean> {
  if (savePromise) return savePromise;
  if (!attempt.value || !pending.length) return Promise.resolve(!saveFailure.value);
  const id = attempt.value.id,
    version = epoch;
  saving.value = true;
  savePromise = (async () => {
    while (pending.length) {
      try {
        const value = await saveQuizProgress(id, pending[0]);
        if (version !== epoch) return false;
        const saved = pending.shift()!;
        const justCompleted = attempt.value?.status !== "completed" && value.status === "completed";
        attempt.value = value;
        saveFailure.value = "";
        if (saved.submit && saved.questionId) pendingSubmissions.value.delete(saved.questionId);
        if (justCompleted) {
          showResults.value = true;
          emit("updated");
        }
      } catch (error) {
        if (version === epoch)
          saveFailure.value = (error as Error).message || "保存失败，请检查网络";
        return false;
      }
    }
    return true;
  })().finally(() => {
    saving.value = false;
    savePromise = null;
  });
  return savePromise;
}
async function retrySave() {
  saveFailure.value = "";
  await flush();
}
function choose(id: string) {
  if (!question.value || locked.value || saveFailure.value) return;
  const q = question.value;
  if (q.type === "SINGLE") {
    selections.value[q.id] = [id];
    pendingSubmissions.value.add(q.id);
    enqueue({
      questionId: q.id,
      selectedOptionIds: [id],
      submit: true,
      currentIndex: currentIndex.value,
    });
  } else {
    const previous = selections.value[q.id] || [];
    const next = previous.includes(id)
      ? previous.filter((value) => value !== id)
      : [...previous, id].sort();
    selections.value[q.id] = next;
    enqueue({ questionId: q.id, selectedOptionIds: [...next], submit: false });
  }
}
function submitMultiple() {
  if (!question.value || !selected.value.length || locked.value || saveFailure.value) return;
  const id = question.value.id;
  pendingSubmissions.value.add(id);
  enqueue({
    questionId: id,
    selectedOptionIds: [...selected.value],
    submit: true,
    currentIndex: currentIndex.value,
  });
}
function navigate(index: number) {
  if (!attempt.value || index < 0 || index >= attempt.value.totalCount) return;
  currentIndex.value = index;
  showResults.value = false;
  enqueue({ currentIndex: index });
  panel.value?.querySelector(".quiz-panel-scroll")?.scrollTo({ top: 0 });
}
async function requestLeave() {
  return await flush();
}
async function close() {
  if (await requestLeave()) {
    exitFullscreen();
    emit("close");
  }
}
async function restartPractice() {
  if (!(await requestLeave())) return;
  loading.value = true;
  loadFailure.value = "";
  newAttemptId = crypto.randomUUID();
  try {
    const value = await createQuizAttempt(props.quizId, newAttemptId);
    hydrate(value);
    emit("updated");
  } catch (error) {
    loadFailure.value = (error as Error).message || "创建练习失败";
  } finally {
    loading.value = false;
  }
}
async function switchAttempt(id: number) {
  if (id === attempt.value?.id || !(await requestLeave())) return;
  loading.value = true;
  loadFailure.value = "";
  try {
    hydrate(await getQuizAttempt(id));
  } catch (error) {
    loadFailure.value = (error as Error).message || "历史记录读取失败";
  } finally {
    loading.value = false;
  }
}
function setFullscreen(value: boolean) {
  fullscreen.value = value;
  emit("fullscreen-change", value);
}
function toggleFullscreen() {
  setFullscreen(!fullscreen.value);
  if (fullscreen.value) void nextTick(() => panel.value?.focus());
}
function exitFullscreen() {
  setFullscreen(false);
}
function onEscape(event: KeyboardEvent) {
  if (event.key === "Escape" && fullscreen.value) {
    event.preventDefault();
    exitFullscreen();
    void nextTick(() => fullscreenButton.value?.focus());
  }
}
function onPanelKey(event: KeyboardEvent) {
  if (!fullscreen.value || event.key !== "Tab") return;
  const focusable = Array.from(
    panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]') || [],
  ).filter((element) => element.getClientRects().length);
  const first = focusable[0],
    last = focusable.at(-1);
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === panel.value)
  ) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
function explain() {
  if (
    !attempt.value ||
    !question.value ||
    !answer.value?.submitted ||
    props.chatBusy ||
    attempt.value.quiz.sourceOutdated
  )
    return;
  emit("explain", {
    attemptId: attempt.value.id,
    questionId: question.value.id,
    documentId: attempt.value.quiz.documentId,
    knowledgeBaseId: attempt.value.quiz.knowledgeBaseId,
    question: buildQuizExplanation(question.value, answer.value),
  });
}
function openSource(index?: number) {
  if (!attempt.value) return;
  const quiz = attempt.value.quiz,
    source = index === undefined ? undefined : question.value?.evidence[index];
  const citation: Citation | undefined = source
    ? {
        number: (index || 0) + 1,
        documentId: quiz.documentId,
        knowledgeBaseId: quiz.knowledgeBaseId,
        versionId: quiz.versionId,
        indexRevisionId: quiz.indexRevisionId,
        chunkId: source.chunkId,
        filename: quiz.filename,
        text: source.quote,
        score: 0,
        sourceOutdated: quiz.sourceOutdated,
        location: source.location as Citation["location"],
      }
    : undefined;
  exitFullscreen();
  emit("open-source", { documentId: quiz.documentId, versionId: quiz.versionId, citation });
}
watch(
  () => props.quizId,
  () => {
    pending.length = 0;
    pendingSubmissions.value.clear();
    saveFailure.value = "";
    newAttemptId = crypto.randomUUID();
    void load();
  },
  { immediate: true },
);
onMounted(() => window.addEventListener("keydown", onEscape));
onBeforeUnmount(() => {
  epoch++;
  window.removeEventListener("keydown", onEscape);
});
defineExpose({
  requestLeave,
  restartPractice,
  exitFullscreen,
  documentId: () => attempt.value?.quiz.documentId,
});
</script>
<style lang="scss" src="./quiz-panel.scss"></style>
