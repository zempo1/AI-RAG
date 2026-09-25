<template>
  <div v-if="!isLoggedIn" class="landing-wrapper">
    <LoginLanding @success="onAuthSuccess" />
  </div>
  <div v-else class="app-layout">
    <Sidebar
      ref="sidebarRef"
      :username="username"
      :current-chat-id="currentChatId"
      @new-chat="startNewChat"
      @select-chat="selectChat"
      @delete-chat="deleteChat"
      @logout="logout"
      @open-settings="openSettings"
      @file-activated="onFileActivated"
      @username-changed="handleUsernameChanged"
    />

    <main class="main-content">
      <Chat ref="chatRef" @chat-created="onChatCreated" />
    </main>

    <Workbench
      ref="workbenchRef"
      :uploaded-file-name="uploadedFileName"
      :uploaded-document-id="uploadedDocumentId"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, nextTick } from "vue";
import Sidebar from "../features/sidebar/Sidebar.vue";
import Chat from "../features/chat/Chat.vue";
import Workbench from "../features/workbench/Workbench.vue";
import LoginLanding from "../features/landing/LoginLanding.vue";

const chatRef = ref<any>(null);
const sidebarRef = ref<any>(null);
const workbenchRef = ref<any>(null);
const currentChatId = ref<number | null>(null);
const username = ref(localStorage.getItem("username") || "用户");
const authToken = ref(localStorage.getItem("token"));
const uploadedFileName = ref("");
const uploadedDocumentId = ref<number | null>(null);

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

const openSettings = () => {
  chatRef.value?.openApiKeyDialog();
};

const selectChat = (id: number) => {
  currentChatId.value = id;
  chatRef.value?.loadHistory(id);
};

const startNewChat = () => {
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