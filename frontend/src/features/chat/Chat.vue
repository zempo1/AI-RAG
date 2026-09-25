<template>
  <div class="chat-wrapper">
    <div class="messages-container" ref="messagesContainer">
      <div v-if="messages.length === 0" class="empty-state">
        <div class="logo-container">
          <div class="logo">AI</div>
        </div>
        <h1>有什么我可以帮您的吗？</h1>
        <p class="subtitle">您可以询问关于上传文档的任何问题</p>
      </div>

      <div
        v-for="(msg, index) in messages"
        :key="index"
        class="message-row"
        :class="msg.role"
      >
        <div class="message-content-wrapper">
          <div class="avatar">
            <div v-if="msg.role === 'assistant'" class="ai-avatar">AI</div>
            <el-avatar
              v-else
              :size="32"
              icon="UserFilled"
              class="user-avatar"
            />
          </div>
          <div class="message-text">
            <div class="role-name">
              {{ msg.role === "user" ? "您" : "AI 助手" }}
            </div>
            <div
              v-if="msg.role === 'assistant'"
              v-html="renderMarkdown(msg.content)"
              class="markdown-body"
            ></div>
            <div v-else class="user-content">{{ msg.content }}</div>
            <span
              v-if="msg.role === 'assistant' && msg.loading"
              class="cursor"
            ></span>
          </div>
        </div>
      </div>
    </div>

    <div class="input-container">
      <div class="input-wrapper">
        <div class="input-box">
          <textarea
            v-model="input"
            placeholder="发送消息..."
            @keydown.enter.prevent="handleEnter"
            :disabled="loading"
            rows="1"
            ref="textareaRef"
          ></textarea>
          <button
            class="send-btn"
            @click="sendMessage"
            :disabled="!input.trim() || loading"
          >
            <el-icon><Promotion /></el-icon>
          </button>
        </div>
        <div class="disclaimer">AI 可能会犯错。请核对重要信息。</div>
      </div>
    </div>

    <el-dialog
      v-model="apiKeyDialogVisible"
      title="API Key 配置"
      width="440px"
      :close-on-click-modal="false"
      class="api-key-dialog"
      :show-close="true"
    >
      <div class="dialog-content">
        <div class="icon-wrapper">
          <div class="key-icon">
            <el-icon><Key /></el-icon>
          </div>
        </div>
        <h3>设置您的 API Key</h3>
        <p class="dialog-desc">
          您的 API Key 仅存储在本地浏览器中，除了用于 LLM
          认证外不会发送到我们的服务器。
        </p>

        <div class="input-group">
          <label>OpenAI / 兼容 Key</label>
          <el-input
            v-model="apiKeyInput"
            placeholder="sk-..."
            type="password"
            show-password
            class="custom-input"
          >
            <template #prefix>
              <el-icon class="input-icon"><Lock /></el-icon>
            </template>
          </el-input>
        </div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="apiKeyDialogVisible = false" class="cancel-btn"
            >取消</el-button
          >
          <el-button type="primary" @click="saveApiKey" class="save-btn">
            保存配置
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch, onMounted } from "vue";
import { UserFilled, Promotion, Key, Lock } from "@element-plus/icons-vue";
import { renderMarkdown } from "../../utils/markdown";
import { getChatHistory, sendStreamChat } from "../../api/chat";
import { useToast } from "../../composables/useToast";

interface Message {
  role: "user" | "assistant";
  content: string;
  loading?: boolean;
}

const emit = defineEmits(["chat-created"]);

const toast = useToast();

const messages = ref<Message[]>([]);
const input = ref("");
const loading = ref(false);
const chatId = ref<number | null>(null);
const messagesContainer = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const apiKeyDialogVisible = ref(false);
const apiKeyInput = ref("");
const userApiKey = ref("");

onMounted(() => {
  const storedKey = localStorage.getItem("user_api_key");
  if (storedKey) {
    userApiKey.value = storedKey;
    apiKeyInput.value = storedKey;
  }
});

const openApiKeyDialog = () => {
  apiKeyInput.value = userApiKey.value;
  apiKeyDialogVisible.value = true;
};

const saveApiKey = () => {
  if (!apiKeyInput.value.trim()) {
    toast.warning("请输入有效的 API Key");
    return;
  }
  userApiKey.value = apiKeyInput.value.trim();
  localStorage.setItem("user_api_key", userApiKey.value);
  apiKeyDialogVisible.value = false;
  toast.success("API Key 已保存");
};

const scrollToBottom = async () => {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
};

const adjustTextareaHeight = () => {
  if (textareaRef.value) {
    textareaRef.value.style.height = "auto";
    textareaRef.value.style.height =
      Math.min(textareaRef.value.scrollHeight, 200) + "px";
  }
};

const loadHistory = async (id: number) => {
  chatId.value = id;
  loading.value = true;
  messages.value = [];
  try {
    const data: any = await getChatHistory(id);
    messages.value = data.messages || [];
  } catch (e) {
    console.error(e);
    toast.error("加载聊天记录失败");
  } finally {
    loading.value = false;
    scrollToBottom();
  }
};

const reset = () => {
  chatId.value = null;
  messages.value = [];
  input.value = "";
  if (textareaRef.value) textareaRef.value.style.height = "auto";
};

defineExpose({ loadHistory, reset, openApiKeyDialog });

watch(input, () => {
  adjustTextareaHeight();
});

const handleEnter = (e: KeyboardEvent) => {
  if (!e.shiftKey) {
    sendMessage();
  }
};

const sendMessage = async () => {
  if (!input.value.trim() || loading.value) return;

  if (!userApiKey.value) {
    toast.warning("请先设置 API Key");
    openApiKeyDialog();
    return;
  }

  const question = input.value;
  messages.value.push({ role: "user", content: question });
  input.value = "";
  if (textareaRef.value) textareaRef.value.style.height = "auto";

  loading.value = true;
  const aiMsgIndex =
    messages.value.push({ role: "assistant", content: "", loading: true }) - 1;

  await scrollToBottom();

  await sendStreamChat(
    { question, chatId: chatId.value },
    {
      onMessage: (token) => {
        messages.value[aiMsgIndex].content += token;
        scrollToBottom();
      },
      onChatId: (id) => {
        chatId.value = id;
        emit("chat-created", id);
      },
      onError: (err) => {
        console.error(err);
        toast.error("获取响应失败");
        messages.value[aiMsgIndex].content += "\n[生成响应时出错]";
      },
      onFinish: async () => {
        loading.value = false;
        if (messages.value[aiMsgIndex]) {
          messages.value[aiMsgIndex].loading = false;
        }
        await scrollToBottom();
      },
    },
  );
};
</script>

<style lang="scss" src="./Chat.scss" scoped></style>