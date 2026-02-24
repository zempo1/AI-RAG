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
      @open-mind-map="openMindMap"
    />

    <main class="main-content">
      <Chat ref="chatRef" @chat-created="onChatCreated" />
    </main>

    <MindMapEditor
      v-model="mindMapEditorVisible"
      :mind-map-data="currentMindMap"
      @saved="onMindMapSaved"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from "vue";
import Sidebar from "./components/Sidebar.vue";
import Chat from "./components/Chat.vue";
import MindMapEditor from "./components/MindMapEditor.vue";
import LoginLanding from "./components/LoginLanding.vue";
import type { MindMap } from "./api/mindmap";

const chatRef = ref<any>(null);
const sidebarRef = ref<any>(null);
const currentChatId = ref<number | null>(null);
const username = ref(localStorage.getItem("username") || "用户");
const authToken = ref(localStorage.getItem("token"));

const isLoggedIn = computed(() => !!authToken.value);

const mindMapEditorVisible = ref(false);
const currentMindMap = ref<MindMap | null>(null);

const onAuthSuccess = (name: string) => {
  authToken.value = localStorage.getItem("token");
  username.value = name;
  sidebarRef.value?.loadChats();
  sidebarRef.value?.loadMindMaps();
};

const handleAuthExpired = () => {
  logout();
};

const openMindMap = (map: MindMap) => {
  currentMindMap.value = map;
  mindMapEditorVisible.value = true;
};

const onMindMapSaved = () => {
  sidebarRef.value?.loadMindMaps();
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

onMounted(() => {
  window.addEventListener("auth-expired", handleAuthExpired);
  if (isLoggedIn.value) {
    sidebarRef.value?.loadChats();
    sidebarRef.value?.loadMindMaps();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("auth-expired", handleAuthExpired);
});
</script>

<style lang="scss">
:root {
  --bg-app: #09090b;
  --bg-sidebar: #121214;
  --bg-card: #1c1c1f;
  --bg-hover: #27272a;
  --text-primary: #f4f4f5;
  --text-secondary: #a1a1aa;
  --border-color: #27272a;
  --primary-gradient: linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%);
  --accent-color: #8b5cf6;
}

body {
  margin: 0;
  padding: 0;
  background-color: var(--bg-app);
  color: var(--text-primary);
  font-family:
    "Inter",
    system-ui,
    -apple-system,
    sans-serif;
}

::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--bg-hover);
  border-radius: 3px;

  &:hover {
    background: var(--text-secondary);
  }
}

::-webkit-scrollbar-corner {
  background: transparent;
}

.app-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-app);
  position: relative;
  background-image:
    radial-gradient(
      circle at 50% 0%,
      rgba(124, 58, 237, 0.05) 0%,
      transparent 50%
    ),
    radial-gradient(
      circle at 100% 100%,
      rgba(6, 182, 212, 0.05) 0%,
      transparent 50%
    );
}
</style>
