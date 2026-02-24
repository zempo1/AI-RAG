<template>
  <div v-if="!isLoggedIn" class="landing-wrapper">
    <LoginLanding @success="onAuthSuccess" />
  </div>
  <div v-else class="app-layout">
    <aside class="sidebar" :class="{ collapsed: isCollapsed }">
      <div class="sidebar-header">
        <div class="header-top">
          <div class="collapse-trigger" @click="toggleSidebar">
            <el-icon><Menu /></el-icon>
          </div>
          <div class="brand" v-show="!isCollapsed">
            <h2>RAG 问答</h2>
          </div>
          <div
            class="new-chat-icon"
            v-show="!isCollapsed"
            @click="startNewChat"
          >
            <el-icon><EditPen /></el-icon>
          </div>
        </div>

        <el-button
          class="new-chat-btn"
          @click="startNewChat"
          :class="{ 'icon-only': isCollapsed }"
          v-if="isCollapsed"
        >
          <el-icon><Plus /></el-icon>
        </el-button>

        <div
          class="new-chat-btn-full"
          @click="startNewChat"
          v-if="!isCollapsed"
        >
          <el-icon><Plus /></el-icon>
          <span>新对话</span>
        </div>
      </div>

      <div class="sidebar-content">
        <div class="section-title" v-show="!isCollapsed">最近</div>
        <div class="chat-list" v-show="!isCollapsed">
          <div
            v-for="chat in chats"
            :key="chat.id"
            class="chat-item"
            :class="{ active: currentChatId === chat.id }"
            @click="selectChat(chat.id)"
          >
            <div class="chat-title-wrapper">
              <el-icon><ChatLineRound /></el-icon>
              <span class="chat-title-text">{{ chat.title }}</span>
            </div>
            <div class="chat-actions">
              <el-icon
                class="delete-icon"
                @click.stop="(e: Event) => deleteChat(chat.id, e)"
                ><Delete
              /></el-icon>
            </div>
          </div>
        </div>

        <div
          class="section-title"
          v-show="!isCollapsed"
          style="margin-top: 24px"
        >
          文档
        </div>
        <div class="upload-wrapper" v-show="!isCollapsed">
          <Upload @generated="onMindMapGenerated" />
        </div>
        <div class="upload-collapsed" v-show="isCollapsed">
          <el-tooltip content="上传文档" placement="right">
            <el-button circle class="collapsed-upload-btn">
              <el-icon><UploadFilled /></el-icon>
            </el-button>
          </el-tooltip>
        </div>

        <div
          class="section-title"
          v-show="!isCollapsed"
          style="margin-top: 24px"
        >
          思维导图
        </div>
        <div class="chat-list" v-show="!isCollapsed">
          <div
            v-for="map in mindMaps"
            :key="map.id"
            class="chat-item"
            @click="openMindMap(map)"
          >
            <div class="chat-title-wrapper">
              <el-icon><Connection /></el-icon>
              <span class="chat-title-text">{{ map.title }}</span>
            </div>
            <div class="chat-actions">
              <el-icon
                class="delete-icon"
                @click.stop="(e: Event) => deleteMindMap(map.id, e)"
                ><Delete
              /></el-icon>
            </div>
          </div>
          <div
            v-if="mindMaps.length === 0"
            style="
              padding: 0 12px;
              color: var(--text-secondary);
              font-size: 0.8rem;
            "
          >
            暂无思维导图
          </div>
        </div>
      </div>

      <div class="sidebar-footer">
        <div class="user-info">
          <el-avatar :size="32" class="user-avatar" icon="UserFilled" />
          <div class="user-details" v-show="!isCollapsed">
            <span class="name">{{ username }}</span>
            <span class="status">专业版</span>
          </div>
          <el-tooltip content="退出登录" placement="top" v-if="!isCollapsed">
            <el-icon class="logout-icon" @click.stop="logout"
              ><SwitchButton
            /></el-icon>
          </el-tooltip>
        </div>
        <div
          class="settings-trigger"
          @click="openSettings"
          v-show="!isCollapsed"
        >
          <el-icon><Setting /></el-icon>
        </div>
      </div>
    </aside>

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
import Upload from "./components/Upload.vue";
import Chat from "./components/Chat.vue";
import MindMapEditor from "./components/MindMapEditor.vue";
import LoginLanding from "./components/LoginLanding.vue";
import {
  getMindMaps,
  deleteMindMap as apiDeleteMindMap,
  type MindMap,
} from "./api/mindmap";
import {
  Plus,
  UserFilled,
  UploadFilled,
  Menu,
  EditPen,
  ChatLineRound,
  Delete,
  Setting,
  Connection,
  SwitchButton,
} from "@element-plus/icons-vue";
import { useConfirm } from "./composables/useConfirm";
import { useToast } from "./composables/useToast";

interface ChatItem {
  id: number;
  title: string;
  createdAt: string;
}

const isCollapsed = ref(false);
const chats = ref<ChatItem[]>([]);
const mindMaps = ref<MindMap[]>([]);
const chatRef = ref<any>(null);
const currentChatId = ref<number | null>(null);
const username = ref(localStorage.getItem("username") || "用户");
const authToken = ref(localStorage.getItem("token"));

const isLoggedIn = computed(() => !!authToken.value);

const confirm = useConfirm();
const toast = useToast();

// Mind Map Logic
const mindMapEditorVisible = ref(false);
const currentMindMap = ref<MindMap | null>(null);

const onAuthSuccess = (name: string) => {
  authToken.value = localStorage.getItem("token");
  username.value = name;
  loadChats();
  loadMindMaps();
};

const handleAuthExpired = () => {
  logout();
};

const loadMindMaps = async () => {
  if (!isLoggedIn.value) return;
  try {
    const res: any = await getMindMaps();
    mindMaps.value = res;
  } catch (e) {
    console.error(e);
  }
};

const openMindMap = (map: MindMap) => {
  currentMindMap.value = map;
  mindMapEditorVisible.value = true;
};

const deleteMindMap = async (id: number, e: Event) => {
  const confirmed = await confirm.danger(
    "确定要删除这个思维导图吗？删除后无法恢复。",
    "删除确认",
  );

  if (!confirmed) return;

  try {
    await apiDeleteMindMap(id);
    await loadMindMaps();
    toast.success("思维导图已删除");
  } catch (e) {
    console.error(e);
    toast.error("删除失败");
  }
};

const onMindMapSaved = () => {
  loadMindMaps();
};

const onMindMapGenerated = () => {
  loadMindMaps();
};

const openSettings = () => {
  chatRef.value?.openApiKeyDialog();
};

const loadChats = async () => {
  if (!isLoggedIn.value) return;
  try {
    const res = await fetch("/api/chats", {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
    });
    if (res.ok) {
      chats.value = await res.json();
    }
  } catch (e) {
    console.error(e);
  }
};

const selectChat = (id: number) => {
  currentChatId.value = id;
  chatRef.value?.loadHistory(id);
};

const startNewChat = () => {
  currentChatId.value = null;
  chatRef.value?.reset();
};

const deleteChat = async (id: number, e: Event) => {
  const confirmed = await confirm.danger(
    "确定要删除这个对话吗？删除后无法恢复。",
    "删除确认",
  );

  if (!confirmed) return;

  try {
    await fetch(`/api/chats/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
    });
    await loadChats();
    if (currentChatId.value === id) {
      startNewChat();
    }
    toast.success("对话已删除");
  } catch (e) {
    console.error(e);
    toast.error("删除失败");
  }
};

const onChatCreated = (id: number) => {
  currentChatId.value = id;
  loadChats();
};

const toggleSidebar = () => {
  isCollapsed.value = !isCollapsed.value;
};

const logout = () => {
  localStorage.removeItem("token");
  localStorage.removeItem("username");
  authToken.value = null;
  username.value = "用户";
  chats.value = [];
  mindMaps.value = [];
  startNewChat();
};

onMounted(() => {
  window.addEventListener("auth-expired", handleAuthExpired);
  if (isLoggedIn.value) {
    loadChats();
    loadMindMaps();
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

.sidebar {
  width: 320px;
  background-color: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  padding: 20px;
  border-right: 1px solid var(--border-color);
  transition:
    width 0.3s ease,
    padding 0.3s ease;
  overflow-x: hidden;

  &.collapsed {
    width: 72px;
    padding: 20px 10px;

    .sidebar-header {
      align-items: center;
      .header-top {
        justify-content: center;
        margin-bottom: 20px;
      }
    }

    .new-chat-btn {
      padding: 0;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--bg-card);
      border: none;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .user-info {
      justify-content: center;
      padding: 8px 0;
    }
  }

  .sidebar-header {
    margin-bottom: 30px;
    display: flex;
    flex-direction: column;

    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      height: 40px;
    }

    .collapse-trigger {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      cursor: pointer;
      color: var(--text-secondary);
      transition: all 0.2s;

      &:hover {
        background-color: var(--bg-hover);
        color: var(--text-primary);
      }

      .el-icon {
        font-size: 20px;
      }
    }

    .brand {
      h2 {
        margin: 0;
        font-size: 1.1rem;
        font-weight: 500;
        color: var(--text-secondary);
      }
    }

    .new-chat-icon {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--text-secondary);
      border-radius: 50%;

      &:hover {
        background-color: var(--bg-hover);
        color: var(--text-primary);
      }

      .el-icon {
        font-size: 20px;
      }
    }
  }

  .new-chat-btn-full {
    height: 44px;
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 22px; /* Pill shape like Gemini */
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: 0 16px;
    font-weight: 500;
    transition: all 0.2s;
    cursor: pointer;

    &:hover {
      background: var(--bg-hover);
      border-color: var(--bg-hover);
    }

    .el-icon {
      margin-right: 12px;
      font-size: 18px;
      color: var(--text-secondary);
    }

    span {
      font-size: 0.9rem;
      color: var(--text-secondary);
    }
  }

  .new-chat-btn {
    background: transparent;
    border: none;
    color: var(--text-secondary);

    &.icon-only {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--bg-hover);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto;

      .el-icon {
        margin: 0;
        font-size: 20px;
      }
    }
  }

  .sidebar-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    margin-right: -0.625rem;
    padding-right: 0.625rem;

    .section-title {
      font-size: 0.75rem;
      color: var(--text-secondary);
      padding: 0 12px;
      margin-bottom: 12px;
      font-weight: 600;
      white-space: nowrap;
    }

    .chat-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 20px;

      .chat-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-radius: 8px;
        cursor: pointer;
        color: var(--text-primary);
        transition: background 0.2s;

        &:hover {
          background: var(--bg-hover);

          .chat-actions {
            opacity: 1;
          }
        }

        &.active {
          background: var(--bg-hover);
          color: white;
        }

        .chat-title-wrapper {
          display: flex;
          align-items: center;
          gap: 12px;
          overflow: hidden;

          .el-icon {
            color: var(--text-secondary);
            font-size: 16px;
          }

          .chat-title-text {
            font-size: 0.9rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
        }

        .chat-actions {
          opacity: 0;
          transition: opacity 0.2s;

          .delete-icon {
            color: var(--text-secondary);
            font-size: 14px;
            padding: 4px;
            border-radius: 4px;

            &:hover {
              background: rgba(255, 255, 255, 0.1);
              color: #ef4444;
            }
          }
        }
      }
    }

    .upload-wrapper {
      padding: 0 4px;
    }

    .upload-collapsed {
      display: flex;
      justify-content: center;
      margin-top: 10px;

      .collapsed-upload-btn {
        background: rgba(255, 255, 255, 0.02);
        border: 1px dashed var(--border-color);
        color: var(--text-secondary);
        width: 40px;
        height: 40px;

        &:hover {
          color: var(--accent-color);
          border-color: var(--accent-color);
          background: var(--bg-hover);
        }
      }
    }
  }

  .sidebar-footer {
    padding-top: 20px;
    border-top: none; /* Removed border for cleaner look */
    display: flex;
    flex-direction: row; /* Changed to row */
    align-items: center;
    justify-content: space-between;
    gap: 10px;

    .user-info {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      cursor: pointer;
      border-radius: 12px;
      transition: background 0.2s;
      white-space: nowrap;
      flex: 1;

      &:hover {
        background-color: var(--bg-hover);
      }

      .user-avatar {
        background: var(--primary-gradient);
        flex-shrink: 0;
      }

      .user-details {
        display: flex;
        flex-direction: column;

        .name {
          font-size: 0.875rem;
          font-weight: 500;
        }

        .status {
          font-size: 0.75rem;
          color: var(--text-secondary);
        }
      }

      .logout-icon {
        color: var(--text-secondary);
        font-size: 18px;
        padding: 4px;
        border-radius: 4px;
        transition: all 0.2s;

        &:hover {
          background: rgba(255, 255, 255, 0.1);
          color: #ef4444;
        }
      }
    }

    .settings-trigger {
      padding: 12px;
      cursor: pointer;
      color: var(--text-secondary);
      border-radius: 12px;
      transition: all 0.2s;

      &:hover {
        background-color: var(--bg-hover);
        color: var(--text-primary);
      }
    }
  }
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-app);
  position: relative;

  /* Add subtle background pattern */
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
