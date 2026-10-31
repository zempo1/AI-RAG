<template>
  <div class="chat-wrapper">
    <div v-if="readOnly" class="chat-status">
      来源知识库已删除，此会话仅可查看。
    </div>
    <div v-else class="chat-status">
      {{
        knowledgeBaseId ? "问答范围：当前知识库中的可用文档" : "请先选择知识库"
      }}
    </div>
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
              v-html="
                renderMarkdown(
                  msg.content,
                  (msg.citations || []).map((c) => c.number),
                )
              "
              @click="handleCitationClick($event, msg)"
              class="markdown-body"
            ></div>
            <div v-if="msg.citations?.length" class="citation-list">
              <span>答案引用</span>
              <button
                v-for="source in msg.citations"
                :key="source.number"
                @click="selectedCitation = source"
              >
                [{{ source.number }}] {{ source.filename
                }}{{
                  source.location?.page
                    ? " · 第 " + source.location.page + " 页"
                    : ""
                }}
              </button>
            </div>
            <details v-if="msg.sources?.length" class="retrieved-sources">
              <summary>检索到的参考资料（{{ msg.sources.length }}）</summary>
              <button
                v-for="source in msg.sources"
                :key="source.number"
                @click="selectedCitation = source"
              >
                {{ source.filename }} · {{ source.text.slice(0, 45) }}
              </button>
            </details>
            <span
              v-if="msg.generationStatus === 'interrupted'"
              class="interrupted-label"
              >生成已中断，内容可能不完整</span
            >
            <div v-if="msg.role === 'user'" class="user-content">
              {{ msg.content }}
            </div>
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
            :disabled="loading || readOnly || !knowledgeBaseId"
            rows="1"
            ref="textareaRef"
          ></textarea>
          <button
            class="send-btn"
            @click="sendMessage"
            :disabled="!input.trim() || loading || readOnly || !knowledgeBaseId"
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
          API Key
          保存在当前浏览器，每次生成时通过后端转发给模型服务，不写入数据库。
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
    <el-drawer
      class="knowledge-theme citation-drawer"
      :model-value="!!selectedCitation"
      title="引用来源"
      size="min(100vw, 540px)"
      append-to-body
      @close="selectedCitation = null"
    >
      <template v-if="selectedCitation">
        <h3>{{ selectedCitation.filename }}</h3>
        <p class="source-location">
          {{
            selectedCitation.location?.page
              ? "第 " + selectedCitation.location.page + " 页 · "
              : ""
          }}
          {{
            selectedCitation.location?.paragraph
              ? "第 " + selectedCitation.location.paragraph + " 段"
              : "历史片段，位置未知"
          }}
          {{
            selectedCitation.location?.heading
              ? " · " + selectedCitation.location.heading
              : ""
          }}
        </p>
        <el-alert
          v-if="selectedCitation.sourceDeleted"
          title="来源已删除，下面展示回答时保存的原文快照。"
          type="warning"
          :closable="false"
        />
        <el-alert
          v-else-if="selectedCitation.sourceOutdated"
          title="来源文档已更新，下面展示回答时使用的历史版本。"
          type="info"
          :closable="false"
        />
        <pre class="source-text">{{ selectedCitation.text }}</pre>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onBeforeUnmount } from "vue";
import { UserFilled, Promotion, Key, Lock } from "@element-plus/icons-vue";
import { renderMarkdown } from "../../utils/markdown";
import { getChatHistory, sendStreamChat } from "../../api/chat";
import { useToast } from "../../composables/useToast";
import type { Citation } from "../../api/knowledge-bases";

interface Message {
  role: "user" | "assistant";
  content: string;
  loading?: boolean;
  citations?: Citation[];
  sources?: Citation[];
  generationStatus?: string;
}

const props = defineProps<{ knowledgeBaseId: number | null }>();
const emit = defineEmits(["chat-created", "history-loaded"]);
const readOnly = ref(false);
const selectedCitation = ref<Citation | null>(null);
let streamAbort: AbortController | undefined;
let epoch = 0;
const handleCitationClick = (event: MouseEvent, message: Message) => {
  const button = (event.target as HTMLElement).closest("[data-citation]");
  if (button)
    selectedCitation.value =
      message.citations?.find(
        (c) => c.number === Number(button.getAttribute("data-citation")),
      ) || null;
};

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

const scrollToBottom = async (instant = false) => {
  await nextTick();
  const el = messagesContainer.value;
  if (el) {
    el.scrollTo({
      top: el.scrollHeight,
      behavior: instant ? ("instant" as ScrollBehavior) : "smooth",
    });
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
  streamAbort?.abort();
  const currentEpoch = ++epoch;
  chatId.value = id;
  loading.value = true;
  messages.value = [];
  try {
    const data: any = await getChatHistory(id);
    if (currentEpoch !== epoch) return;
    messages.value = data.messages || [];
    readOnly.value = !!data.readOnly;
    emit("history-loaded", data.knowledgeBaseId);
  } catch (e) {
    console.error(e);
    toast.error("加载聊天记录失败");
  } finally {
    if (currentEpoch === epoch) loading.value = false;
    scrollToBottom(true);
  }
};

const reset = () => {
  streamAbort?.abort();
  epoch++;
  loading.value = false;
  readOnly.value = false;
  selectedCitation.value = null;
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
  if (
    !input.value.trim() ||
    loading.value ||
    readOnly.value ||
    !props.knowledgeBaseId
  )
    return;
  const currentEpoch = ++epoch;
  streamAbort = new AbortController();

  const question = input.value;
  messages.value.push({ role: "user", content: question });
  input.value = "";
  if (textareaRef.value) textareaRef.value.style.height = "auto";

  loading.value = true;
  const aiMsgIndex =
    messages.value.push({ role: "assistant", content: "", loading: true }) - 1;

  await scrollToBottom();

  await sendStreamChat(
    { question, chatId: chatId.value, knowledgeBaseId: props.knowledgeBaseId },
    {
      onMessage: (token) => {
        if (currentEpoch !== epoch) return;
        messages.value[aiMsgIndex].content += token;
        scrollToBottom();
      },
      onChatId: (id) => {
        if (currentEpoch !== epoch) return;
        chatId.value = id;
        emit("chat-created", id);
      },
      onSources: (sources) => {
        if (currentEpoch === epoch)
          messages.value[aiMsgIndex].sources = sources;
      },
      onDone: (final) => {
        if (currentEpoch !== epoch) return;
        Object.assign(messages.value[aiMsgIndex], {
          content: final.answer,
          citations: final.citations,
          generationStatus: final.generationStatus,
        });
      },
      onError: (err) => {
        if (currentEpoch !== epoch) return;
        console.error(err);
        toast.error(err instanceof Error ? err.message : "获取响应失败");
        const message = messages.value[aiMsgIndex];
        message.generationStatus = "interrupted";
        const candidates = new Map(
          (message.sources || []).map((source) => [source.number, source]),
        );
        const used = new Map<number, Citation>();
        message.content = message.content.replace(
          /\[(\d+)\]/g,
          (marker, number) => {
            const source = candidates.get(Number(number));
            if (!source) return "";
            used.set(source.number, source);
            return marker;
          },
        );
        message.citations = [...used.values()];
      },
      onFinish: async () => {
        if (currentEpoch !== epoch) return;
        loading.value = false;
        if (messages.value[aiMsgIndex]) {
          messages.value[aiMsgIndex].loading = false;
        }
        await scrollToBottom();
      },
    },
    streamAbort.signal,
  );
};
onBeforeUnmount(() => {
  epoch++;
  streamAbort?.abort();
});
</script>

<style lang="scss" src="./Chat.scss" scoped></style>
<style scoped>
:global(.citation-drawer .el-drawer__body) {
  color: var(--text-primary);
}
:global(.citation-drawer) {
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border-color);
}
:global(.citation-drawer .el-drawer__header) {
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 0;
  padding-bottom: 20px;
}
.chat-status {
  padding: 10px 24px;
  color: var(--text-secondary);
  font-size: 12px;
  border-bottom: 1px solid var(--border-color);
}
.citation-list {
  margin-top: 14px;
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  align-items: center;
  font-size: 12px;
  color: #7b8497;
}
.citation-list button,
.retrieved-sources button {
  border: 1px solid #4c3b69;
  border-radius: 6px;
  padding: 5px 8px;
  background: #262031;
  color: #d7c8ff;
  cursor: pointer;
  text-align: left;
}
.retrieved-sources {
  margin-top: 12px;
  color: #7b8497;
  font-size: 12px;
}
.retrieved-sources button {
  display: block;
  margin-top: 5px;
}
.source-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
  font-family: inherit;
  padding: 18px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
}
.source-location,
.interrupted-label {
  color: #d5bb90;
  font-size: 12px;
}
:deep(.inline-citation) {
  border: 0;
  border-radius: 4px;
  color: #d7c8ff;
  background: #30243f;
  padding: 0 4px;
  cursor: pointer;
  font: inherit;
}
</style>
