<template>
  <div v-if="!isLoggedIn" class="landing-wrapper">
    <LoginLanding @success="onAuthSuccess" />
  </div>
  <div v-else class="app-layout" :class="{ 'reader-is-open': !!readerTarget }">
    <Sidebar
      ref="sidebarRef"
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
      @file-deleted="onFileDeleted"
      @preview-document="openReader"
      @knowledge-base-deleted="clearReader"
      @username-changed="handleUsernameChanged"
    />

    <main class="main-content">
      <Chat
        ref="chatRef"
        :knowledge-base-id="knowledgeBaseId"
        @chat-created="onChatCreated"
        @history-loaded="onHistoryLoaded"
        @open-source="openReader"
      />
    </main>

    <SourcePanel v-if="readerTarget" :target="readerTarget" @close="closeReader" />

    <Workbench
      v-show="!readerTarget"
      ref="workbenchRef"
      :uploaded-file-name="uploadedFileName"
      :uploaded-document-id="uploadedDocumentId"
    />
    <ModelSettingsDialog ref="modelSettingsRef" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, nextTick, defineAsyncComponent } from "vue";
import Sidebar from "../features/sidebar/Sidebar.vue";
import Chat from "../features/chat/Chat.vue";
import Workbench from "../features/workbench/Workbench.vue";
import LoginLanding from "../features/landing/LoginLanding.vue";
import ModelSettingsDialog from '../features/settings/ModelSettingsDialog.vue';
import type { DocumentTarget } from '../features/reader/types';
const SourcePanel = defineAsyncComponent(() => import('../features/reader/SourcePanel.vue'));

const chatRef = ref<any>(null);
const modelSettingsRef = ref<InstanceType<typeof ModelSettingsDialog>>();
const sidebarRef = ref<any>(null);
const workbenchRef = ref<any>(null);
const currentChatId = ref<number | null>(null);
const knowledgeBaseId = ref<number | null>(null);
const username = ref(localStorage.getItem("username") || "用户");
const authToken = ref(localStorage.getItem("token"));
const uploadedFileName = ref("");
const uploadedDocumentId = ref<number | null>(null);
const readerTarget = ref<DocumentTarget | null>(null);
let readerTrigger: HTMLElement | null = null;
const openReader = (target: DocumentTarget) => {
  const active = document.activeElement;
  if (active instanceof HTMLElement && !active.closest('.source-panel')) readerTrigger = active;
  readerTarget.value = target;
};
const closeReader = () => {
  readerTarget.value = null;
  const trigger = readerTrigger;
  readerTrigger = null;
  void nextTick(() => {
    if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
    else (document.querySelector('.library-feature button') as HTMLElement | null)?.focus({ preventScroll: true });
  });
};
const clearReader = () => { readerTarget.value = null; readerTrigger = null; };

const isLoggedIn = computed(() => !!authToken.value);

const onAuthSuccess = async (name: string) => {
  authToken.value = localStorage.getItem("token");
  username.value = name;
  setTimeout(() => {
    sidebarRef.value?.loadChats();
    workbenchRef.value?.loadMindMaps();
  }, 100);
};

const handleAuthExpired = () => {
  logout();
};

const onFileActivated = (filename: string, id: number | null) => {
  uploadedFileName.value = filename;
  uploadedDocumentId.value = id;
};

const onFileDeleted = (id: number) => {
  if (readerTarget.value?.documentId === id) clearReader();
  if (uploadedDocumentId.value === id) onFileActivated("", null);
  workbenchRef.value?.onSourceDeleted(id);
};

const refreshWorkbench = () => workbenchRef.value?.refresh();
const changeKnowledgeBase = (id: number) => {
  if (knowledgeBaseId.value === id) return;
  knowledgeBaseId.value = id;
  startNewChat();
  onFileActivated("", null);
};
const onHistoryLoaded = (id: number) => {
  if (knowledgeBaseId.value !== id) onFileActivated("", null);
  knowledgeBaseId.value = id;
};

const openSettings = () => {
  modelSettingsRef.value?.open();
};

const selectChat = (id: number) => {
  clearReader();
  currentChatId.value = id;
  chatRef.value?.loadHistory(id);
};

const startNewChat = () => {
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
  authToken.value = null;
  knowledgeBaseId.value = null;
  username.value = "用户";
  startNewChat();
};

const handleUsernameChanged = (newUsername: string) => {
  username.value = newUsername;
};

onMounted(async () => {
  window.addEventListener("auth-expired", handleAuthExpired);
  if (isLoggedIn.value) {
    await nextTick();
    sidebarRef.value?.loadChats();
    workbenchRef.value?.loadMindMaps();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("auth-expired", handleAuthExpired);
});
</script>

<style lang="scss" src="./App.scss"></style>
