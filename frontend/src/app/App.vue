<template>
  <div v-if="!isLoggedIn" class="landing-wrapper">
    <LoginLanding @success="onAuthSuccess" />
  </div>
  <div
    v-else
    class="app-layout"
    :class="{
      'reader-is-open': !!readerTarget || mindMapId !== null || quizId !== null,
      'panel-is-fullscreen': panelFullscreen,
    }"
  >
    <Sidebar
      id="document-sidebar"
      ref="sidebarRef"
      v-model:collapsed="sidebarCollapsed"
      :style="{ width: widths.sidebar + 'px', boxSizing: 'border-box', transition: 'none' }"
      :username="username"
      :current-chat-id="currentChatId"
      :knowledge-base-id="knowledgeBaseId"
      :document-id="uploadedDocumentId"
      @knowledge-base-change="changeKnowledgeBase"
      @version-changed="refreshWorkbench"
      @new-chat="startNewChat"
      @select-chat="selectChat"
      @delete-chat="deleteChat"
      @logout="logout"
      @open-settings="openSettings"
      @file-activated="onFileActivated"
      @source-ready="uploadedDocumentReady = $event"
      @file-deleted="onFileDeleted"
      @preview-document="openReader"
      @knowledge-base-deleted="clearReader"
      @username-changed="handleUsernameChanged"
    />

    <PanelResizeHandle
      v-if="widths.desktop && !sidebarCollapsed && !panelFullscreen"
      label="调整文档侧栏宽度"
      controls="document-sidebar"
      :value="widths.sidebar"
      :min="240"
      :max="widths.sidebarMax"
      @resize="resizeSidebar"
      @reset="resetSidebarWidth"
    />

    <main class="main-content">
      <button
        v-if="quizId !== null && quizHiddenForChat && !readerTarget"
        class="return-to-quiz"
        @click="quizHiddenForChat = false"
      >
        返回测验
      </button>
      <Chat
        ref="chatRef"
        :knowledge-base-id="knowledgeBaseId"
        @chat-created="onChatCreated"
        @history-loaded="onHistoryLoaded"
        @open-source="openReader"
        @availability-change="chatAvailability = $event"
      />
    </main>

    <PanelResizeHandle
      v-if="
        widths.desktop && !panelFullscreen && !(rightMode === 'workbench' && workbenchCollapsed)
      "
      label="调整右侧面板宽度"
      :controls="'panel-' + rightMode"
      :value="widths.right"
      :min="widths.rightMin"
      :max="widths.rightMax"
      :direction="-1"
      @resize="resizeRight"
      @reset="resetRightWidth"
    />

    <SourcePanel
      v-if="readerTarget"
      id="panel-reader"
      :style="rightPanelStyle"
      :target="readerTarget"
      @close="closeReader"
    />

    <MindMapEditor
      v-if="mindMapId !== null"
      ref="mindMapEditor"
      id="panel-mindmap"
      :style="rightPanelStyle"
      :map-id="mindMapId"
      @close="closeMindMap"
      @saved="refreshWorkbench"
      @fullscreen-change="panelFullscreen = $event"
    />

    <QuizPanel
      v-if="quizId !== null"
      v-show="!readerTarget && !quizHiddenForChat"
      ref="quizPanelRef"
      id="panel-quiz"
      :key="quizId"
      :style="rightPanelStyle"
      :quiz-id="quizId"
      :restart="quizRestart"
      :chat-busy="chatAvailability.loading"
      @close="closeQuiz"
      @explain="explainQuiz"
      @open-source="openReader"
      @fullscreen-change="panelFullscreen = $event"
      @updated="refreshWorkbench"
    />

    <Workbench
      v-show="!readerTarget && mindMapId === null && quizId === null"
      ref="workbenchRef"
      id="panel-workbench"
      :style="rightPanelStyle"
      v-model:collapsed="workbenchCollapsed"
      :active="!readerTarget && mindMapId === null && quizId === null"
      :knowledge-base-id="knowledgeBaseId"
      @open-mindmap="openMindMap"
      @open-quiz="openQuiz"
      :uploaded-file-name="uploadedFileName"
      :uploaded-document-id="uploadedDocumentId"
      :uploaded-document-ready="uploadedDocumentReady"
    />
    <ModelSettingsDialog ref="modelSettingsRef" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, nextTick, defineAsyncComponent } from "vue";
import { watch } from "vue";
import PanelResizeHandle from "../components/PanelResizeHandle.vue";
import {
  clamp,
  defaultPanelPreferences,
  panelAccountKey,
  readPanelPreferences,
  resolvePanelWidths,
  savePanelPreferences,
  type RightPanelMode,
} from "../utils/panel-layout";
import { useToast } from "../composables/useToast";
import Sidebar from "../features/sidebar/Sidebar.vue";
import Chat from "../features/chat/Chat.vue";
import Workbench from "../features/workbench/Workbench.vue";
import LoginLanding from "../features/landing/LoginLanding.vue";
import ModelSettingsDialog from "../features/settings/ModelSettingsDialog.vue";
import type { DocumentTarget } from "../features/reader/types";
const MindMapEditor = defineAsyncComponent(() => import("../features/mindmap/MindMapEditor.vue"));
const QuizPanel = defineAsyncComponent(() => import("../features/quiz/QuizPanel.vue"));
const quizId = ref<number | null>(null),
  quizRestart = ref(false),
  quizPanelRef = ref<any>();
const quizHiddenForChat = ref(false),
  panelFullscreen = ref(false);
const chatAvailability = ref({ loading: false, readOnly: false });
const toast = useToast();
const mindMapId = ref<number | null>(null);
const mindMapEditor = ref<any>();
let panelRevision = 0;
async function leaveMindMap() {
  if (mindMapEditor.value && !(await mindMapEditor.value.requestLeave())) return false;
  return !quizPanelRef.value?.requestLeave || (await quizPanelRef.value.requestLeave());
}
async function openQuiz(id: number, restart = false) {
  const revision = ++panelRevision;
  if (!(await leaveMindMap()) || revision !== panelRevision) return;
  readerTarget.value = null;
  mindMapId.value = null;
  panelFullscreen.value = false;
  quizHiddenForChat.value = false;
  if (quizId.value === id && restart) {
    await quizPanelRef.value?.restartPractice?.();
    return;
  }
  quizRestart.value = restart;
  quizId.value = id;
}
function closeQuiz() {
  panelRevision++;
  quizId.value = null;
  quizHiddenForChat.value = false;
  panelFullscreen.value = false;
  refreshWorkbench();
}
async function explainQuiz(payload: {
  attemptId: number;
  questionId: string;
  documentId: number;
  knowledgeBaseId: number;
  question: string;
}) {
  if (chatAvailability.value.loading) {
    toast.warning("请等待当前回答完成后再解释题目");
    return;
  }
  if (knowledgeBaseId.value !== payload.knowledgeBaseId) {
    toast.error("知识库已切换，请重新打开测验");
    return;
  }
  quizPanelRef.value?.exitFullscreen?.();
  panelFullscreen.value = false;
  if (!widths.value.desktop) quizHiddenForChat.value = true;
  await nextTick();
  const accepted = await chatRef.value?.sendExternalQuestion(payload.question, {
    documentIds: [payload.documentId],
    mode: "search",
    quizContext: { attemptId: payload.attemptId, questionId: payload.questionId },
  });
  if (!accepted) toast.warning("当前聊天暂不可用，请稍后重试");
}
async function openMindMap(id: number) {
  const revision = ++panelRevision;
  if (id === mindMapId.value) return;
  if (!(await leaveMindMap()) || revision !== panelRevision) return;
  readerTarget.value = null;
  quizId.value = null;
  panelFullscreen.value = false;
  mindMapId.value = id;
}
function closeMindMap() {
  panelRevision++;
  mindMapId.value = null;
  panelFullscreen.value = false;
}
const SourcePanel = defineAsyncComponent(() => import("../features/reader/SourcePanel.vue"));

const chatRef = ref<any>(null);
const modelSettingsRef = ref<InstanceType<typeof ModelSettingsDialog>>();
const sidebarRef = ref<any>(null);
const workbenchRef = ref<any>(null);
const currentChatId = ref<number | null>(null);
const knowledgeBaseId = ref<number | null>(null);
const username = ref(localStorage.getItem("username") || "用户");
const authToken = ref(localStorage.getItem("token"));
const sidebarCollapsed = ref(false),
  workbenchCollapsed = ref(false),
  viewportWidth = ref(window.innerWidth);
const accountKey = computed(() => panelAccountKey(authToken.value, username.value));
const panelPreferences = ref(readPanelPreferences(localStorage, accountKey.value));
const rightMode = computed<RightPanelMode>(() =>
  readerTarget.value
    ? "reader"
    : mindMapId.value !== null
      ? "mindmap"
      : quizId.value !== null
        ? "quiz"
        : "workbench",
);
const widths = computed(() =>
  resolvePanelWidths(
    viewportWidth.value,
    panelPreferences.value,
    rightMode.value,
    sidebarCollapsed.value,
    workbenchCollapsed.value,
  ),
);
const rightPanelStyle = computed(() =>
  widths.value.desktop && !panelFullscreen.value
    ? {
        width: widths.value.right + "px",
        flex: "0 0 auto",
        boxSizing: "border-box" as const,
        transition: "none",
      }
    : {},
);
watch(accountKey, (key) => {
  panelPreferences.value = readPanelPreferences(localStorage, key);
});
watch(panelPreferences, (prefs) => savePanelPreferences(localStorage, accountKey.value, prefs), {
  deep: true,
});
function resizeSidebar(value: number) {
  panelPreferences.value.sidebar = clamp(value, 240, widths.value.sidebarMax);
}
function resizeRight(value: number) {
  const width = clamp(value, widths.value.rightMin, widths.value.rightMax);
  if (rightMode.value === "workbench") panelPreferences.value.workbench = width;
  else panelPreferences.value[rightMode.value] = width / widths.value.available;
}
function resetSidebarWidth() {
  panelPreferences.value.sidebar = 300;
}
function resetRightWidth() {
  const mode = rightMode.value;
  panelPreferences.value[mode] = defaultPanelPreferences()[mode];
}
const onWindowResize = () => {
  viewportWidth.value = window.innerWidth;
};
const uploadedFileName = ref("");
const uploadedDocumentId = ref<number | null>(null);
const uploadedDocumentReady = ref(false);
const readerTarget = ref<DocumentTarget | null>(null);
let readerTrigger: HTMLElement | null = null;
const openReader = async (target: DocumentTarget) => {
  const revision = ++panelRevision;
  if (!(await leaveMindMap()) || revision !== panelRevision) return;
  mindMapId.value = null;
  quizPanelRef.value?.exitFullscreen?.();
  panelFullscreen.value = false;
  const active = document.activeElement;
  if (active instanceof HTMLElement && !active.closest(".source-panel")) readerTrigger = active;
  readerTarget.value = target;
};
const closeReader = () => {
  readerTarget.value = null;
  const trigger = readerTrigger;
  readerTrigger = null;
  void nextTick(() => {
    if (trigger?.isConnected && trigger.getClientRects().length)
      trigger.focus({ preventScroll: true });
    else
      (document.querySelector(".library-feature button") as HTMLElement | null)?.focus({
        preventScroll: true,
      });
  });
};
const clearReader = () => {
  closeMindMap();
  quizId.value = null;
  quizHiddenForChat.value = false;
  readerTarget.value = null;
  readerTrigger = null;
};

const isLoggedIn = computed(() => !!authToken.value);

const onAuthSuccess = async (name: string) => {
  authToken.value = localStorage.getItem("token");
  username.value = name;
  await nextTick();
  sidebarRef.value?.loadChats();
};

const handleAuthExpired = () => {
  logout();
};

const onFileActivated = (filename: string, id: number | null) => {
  uploadedFileName.value = filename;
  uploadedDocumentId.value = id;
  if (!id) uploadedDocumentReady.value = false;
};

const onFileDeleted = (id: number) => {
  if (quizPanelRef.value?.documentId?.() === id) closeQuiz();
  if (mindMapEditor.value?.documentId() === id) closeMindMap();
  if (readerTarget.value?.documentId === id) clearReader();
  if (uploadedDocumentId.value === id) onFileActivated("", null);
  workbenchRef.value?.onSourceDeleted(id);
};

const refreshWorkbench = () => workbenchRef.value?.refresh();
const changeKnowledgeBase = async (id: number) => {
  if (knowledgeBaseId.value === id) return;
  if (!(await leaveMindMap())) return;
  knowledgeBaseId.value = id;
  resetChat();
  onFileActivated("", null);
};
const onHistoryLoaded = (id: number) => {
  if (knowledgeBaseId.value !== id) onFileActivated("", null);
  knowledgeBaseId.value = id;
};

const openSettings = () => {
  modelSettingsRef.value?.open();
};

const selectChat = async (id: number) => {
  if (!(await leaveMindMap())) return;
  clearReader();
  currentChatId.value = id;
  chatRef.value?.loadHistory(id);
};

const startNewChat = async () => {
  if (isLoggedIn.value && !(await leaveMindMap())) return;
  resetChat();
};
const resetChat = () => {
  clearReader();
  currentChatId.value = null;
  chatRef.value?.reset();
};

const deleteChat = async (id: number) => {
  try {
    await fetch(`/api/chats/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
    });
    sidebarRef.value?.loadChats();
    if (currentChatId.value === id) {
      startNewChat();
    }
  } catch (e) {
    console.error(e);
  }
};

const onChatCreated = (id: number) => {
  currentChatId.value = id;
  sidebarRef.value?.loadChats();
};

const logout = () => {
  localStorage.removeItem("token");
  localStorage.removeItem("username");
  closeMindMap();
  authToken.value = null;
  knowledgeBaseId.value = null;
  username.value = "用户";
  resetChat();
};

const handleUsernameChanged = (newUsername: string) => {
  username.value = newUsername;
};

onMounted(async () => {
  window.addEventListener("resize", onWindowResize);
  window.addEventListener("auth-expired", handleAuthExpired);
  if (isLoggedIn.value) {
    await nextTick();
    sidebarRef.value?.loadChats();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("auth-expired", handleAuthExpired);
});
</script>

<style lang="scss" src="./App.scss"></style>
