<template>
  <aside class="sidebar" :class="{ collapsed: isCollapsed }">
    <div class="sidebar-header">
      <div class="header-top">
        <div class="collapse-trigger" @click="toggleSidebar">
          <el-icon><Menu /></el-icon>
        </div>
        <div class="brand" v-show="!isCollapsed">
          <h2>RAG 问答</h2>
        </div>
        <div v-if="!isCollapsed" class="settings-icon-wrapper">
          <el-tooltip content="API Key 设置" placement="bottom">
            <div class="settings-icon" @click="handleOpenSettings">
              <el-icon><Key /></el-icon>
            </div>
          </el-tooltip>
        </div>
      </div>

      <el-button
        class="new-chat-btn"
        @click="handleNewChat"
        :class="{ 'icon-only': isCollapsed }"
        v-if="isCollapsed"
      >
        <el-icon><Plus /></el-icon>
      </el-button>

      <div class="new-chat-btn-full" @click="handleNewChat" v-if="!isCollapsed">
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
          @click="handleSelectChat(chat.id)"
        >
          <div class="chat-title-wrapper">
            <el-icon><ChatLineRound /></el-icon>
            <el-tooltip :content="chat.title" placement="right" :show-after="400" :hide-after="0">
              <span class="chat-title-text">{{ chat.title }}</span>
            </el-tooltip>
          </div>
          <div class="chat-actions">
            <el-icon
              class="delete-icon"
              @click.stop="handleDeleteChat(chat.id)"
            >
              <Delete />
            </el-icon>
          </div>
        </div>
      </div>

      <div class="section-title" v-show="!isCollapsed" style="margin-top: 24px">
        文档
      </div>
      <div class="upload-wrapper" v-show="!isCollapsed">
        <Upload @activated="handleFileActivated" />
      </div>
      <div class="upload-collapsed" v-show="isCollapsed">
        <el-tooltip content="上传文档" placement="right">
          <el-button circle class="collapsed-upload-btn">
            <el-icon><UploadFilled /></el-icon>
          </el-button>
        </el-tooltip>
      </div>

    </div>

    <div class="sidebar-footer">
      <div class="user-info">
        <el-avatar :size="32" class="user-avatar" icon="UserFilled" />
        <div class="user-details" v-show="!isCollapsed">
          <span class="name">{{ username }}</span>
          <span class="status">专业版</span>
        </div>
        <div class="user-actions" v-if="!isCollapsed">
          <el-tooltip content="账户设置" placement="top">
            <el-icon class="action-icon" @click.stop="handleChangePassword">
              <Setting />
            </el-icon>
          </el-tooltip>
          <el-tooltip content="退出登录" placement="top">
            <el-icon class="action-icon logout" @click.stop="handleLogout">
              <SwitchButton />
            </el-icon>
          </el-tooltip>
        </div>
      </div>
    </div>

    <ChangePasswordDialog
      v-model="changePasswordVisible"
      :current-username="username"
      @success="handlePasswordChanged"
      @username-changed="handleUsernameChanged"
    />
  </aside>
</template>

<script setup lang="ts">
import { ref } from "vue";
import Upload from "../upload/Upload.vue";
import ChangePasswordDialog from "../account/ChangePasswordDialog.vue";
import {
  Plus,
  UserFilled,
  UploadFilled,
  Menu,
  EditPen,
  ChatLineRound,
  Delete,
  Setting,
  SwitchButton,
  Key,
} from "@element-plus/icons-vue";
import { useConfirm } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";
import type { ChatItem } from "../../types";
import request from "../../utils/request";

const props = defineProps<{
  username: string;
  currentChatId: number | null;
}>();

const emit = defineEmits<{
  (e: "new-chat"): void;
  (e: "select-chat", id: number): void;
  (e: "delete-chat", id: number): void;
  (e: "logout"): void;
  (e: "open-settings"): void;
  (e: "file-activated", filename: string, id: number | null): void;
  (e: "username-changed", username: string): void;
}>();

const confirm = useConfirm();
const toast = useToast();

const isCollapsed = ref(false);
const chats = ref<ChatItem[]>([]);
const changePasswordVisible = ref(false);

const toggleSidebar = () => {
  isCollapsed.value = !isCollapsed.value;
};

const handleNewChat = () => {
  emit("new-chat");
};

const handleSelectChat = (id: number) => {
  emit("select-chat", id);
};

const handleDeleteChat = async (id: number) => {
  const confirmed = await confirm.danger(
    "确定要删除这个对话吗？删除后无法恢复。",
    "删除确认",
  );
  if (!confirmed) return;
  emit("delete-chat", id);
  toast.success("对话已删除");
};

const handleLogout = async () => {
  const confirmed = await confirm.warning("确定要退出登录吗？", "退出确认");
  if (!confirmed) return;
  emit("logout");
  toast.success("退出成功");
};

const handleOpenSettings = () => {
  emit("open-settings");
};

const handleChangePassword = () => {
  changePasswordVisible.value = true;
};

const handlePasswordChanged = () => {};

const handleUsernameChanged = (newUsername: string) => {
  emit("username-changed", newUsername);
};

const handleFileActivated = (filename: string, id: number | null) => {
  emit("file-activated", filename, id);
};

const loadChats = async () => {
  try {
    const res = await request.get<any, ChatItem[]>("/api/chats");
    chats.value = res;
  } catch (e) {
    console.error(e);
  }
};

defineExpose({
  loadChats,
});
</script>

<style lang="scss" src="./Sidebar.scss" scoped></style>