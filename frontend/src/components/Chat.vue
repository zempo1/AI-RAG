<template>
  <div class="chat-wrapper">
    <div class="messages-container" ref="messagesContainer">
      <div v-if="messages.length === 0" class="empty-state">
        <div class="logo-container">
          <div class="logo">AI</div>
        </div>
        <h1>How can I help you today?</h1>
        <p class="subtitle">Ask anything about your uploaded documents</p>
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
            <el-avatar v-else :size="32" icon="UserFilled" class="user-avatar" />
          </div>
          <div class="message-text">
            <div class="role-name">{{ msg.role === 'user' ? 'You' : 'AI Assistant' }}</div>
            <div v-if="msg.role === 'assistant'" v-html="renderMarkdown(msg.content)" class="markdown-body"></div>
            <div v-else class="user-content">{{ msg.content }}</div>
            <span v-if="msg.role === 'assistant' && msg.loading" class="cursor"></span>
          </div>
        </div>
      </div>
    </div>
    
    <div class="input-container">
      <div class="input-wrapper">
        <div class="input-box">
          <textarea 
            v-model="input" 
            placeholder="Send a message..." 
            @keydown.enter.prevent="handleEnter"
            :disabled="loading"
            rows="1"
            ref="textareaRef"
          ></textarea>
          <button class="send-btn" @click="sendMessage" :disabled="!input.trim() || loading">
            <el-icon><Promotion /></el-icon>
          </button>
        </div>
        <div class="disclaimer">
          AI can make mistakes. Consider checking important information.
        </div>
      </div>
    </div>

    <el-dialog
      v-model="apiKeyDialogVisible"
      title="API Key Configuration"
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
         <h3>Set Your API Key</h3>
         <p class="dialog-desc">Your API key is stored locally in your browser and never sent to our servers except to authenticate with the LLM provider.</p>
         
         <div class="input-group">
            <label>OpenAI / Compatible Key</label>
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
          <el-button @click="apiKeyDialogVisible = false" class="cancel-btn">Cancel</el-button>
          <el-button type="primary" @click="saveApiKey" class="save-btn">
            Save Configuration
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { UserFilled, Promotion, Key, Lock } from '@element-plus/icons-vue'
import { renderMarkdown } from '../utils/markdown'
import { getChatHistory, sendStreamChat } from '../api/chat'

interface Message {
  role: 'user' | 'assistant'
  content: string
  loading?: boolean
}

const emit = defineEmits(['chat-created'])

const messages = ref<Message[]>([])
const input = ref('')
const loading = ref(false)
const chatId = ref<number | null>(null)
const messagesContainer = ref<HTMLElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

// API Key Logic
const apiKeyDialogVisible = ref(false)
const apiKeyInput = ref('')
const userApiKey = ref('')

onMounted(() => {
    const storedKey = localStorage.getItem('user_api_key')
    if (storedKey) {
        userApiKey.value = storedKey
        apiKeyInput.value = storedKey
    }
})

const openApiKeyDialog = () => {
    apiKeyInput.value = userApiKey.value
    apiKeyDialogVisible.value = true
}

const saveApiKey = () => {
    if (!apiKeyInput.value.trim()) {
        ElMessage.warning('Please enter a valid API Key')
        return
    }
    userApiKey.value = apiKeyInput.value.trim()
    localStorage.setItem('user_api_key', userApiKey.value)
    apiKeyDialogVisible.value = false
    ElMessage.success('API Key saved')
}

const scrollToBottom = async () => {
  await nextTick()
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

const adjustTextareaHeight = () => {
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
    textareaRef.value.style.height = Math.min(textareaRef.value.scrollHeight, 200) + 'px'
  }
}

const loadHistory = async (id: number) => {
    chatId.value = id
    loading.value = true
    messages.value = []
    try {
        const data: any = await getChatHistory(id)
        messages.value = data.messages || []
    } catch (e) {
        console.error(e)
    } finally {
        loading.value = false
        scrollToBottom()
    }
}

const reset = () => {
    chatId.value = null
    messages.value = []
    input.value = ''
    if(textareaRef.value) textareaRef.value.style.height = 'auto'
}

defineExpose({ loadHistory, reset, openApiKeyDialog })

watch(input, () => {
  adjustTextareaHeight()
})

const handleEnter = (e: KeyboardEvent) => {
  if (!e.shiftKey) {
    sendMessage()
  }
}

const sendMessage = async () => {
  if (!input.value.trim() || loading.value) return
  
  if (!userApiKey.value) {
      ElMessage.warning('Please set your API Key first')
      openApiKeyDialog()
      return
  }
  
  const question = input.value
  messages.value.push({ role: 'user', content: question })
  input.value = ''
  if(textareaRef.value) textareaRef.value.style.height = 'auto'
  
  loading.value = true
  const aiMsgIndex = messages.value.push({ role: 'assistant', content: '', loading: true }) - 1
  
  await scrollToBottom()

  await sendStreamChat(
    { question, chatId: chatId.value },
    {
      onMessage: (token) => {
        messages.value[aiMsgIndex].content += token
        scrollToBottom()
      },
      onChatId: (id) => {
        chatId.value = id
        emit('chat-created', id)
      },
      onError: (err) => {
        console.error(err)
        ElMessage.error('Failed to get response')
        messages.value[aiMsgIndex].content += "\n[Error generating response]"
      },
      onFinish: async () => {
        loading.value = false
        if (messages.value[aiMsgIndex]) {
            messages.value[aiMsgIndex].loading = false
        }
        await scrollToBottom()
      }
    }
  )
}
</script>

<style scoped lang="scss">

  :deep(.el-dialog) {
      background: #1c1c1f;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      padding: 0;
      overflow: hidden;
  }

  :deep(.el-dialog__header) {
      margin: 0;
      padding: 20px 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      
      .el-dialog__title {
          color: var(--text-primary);
          font-size: 16px;
          font-weight: 600;
      }
      
      .el-dialog__headerbtn .el-dialog__close {
          color: var(--text-secondary);
          &:hover {
              color: var(--text-primary);
          }
      }
  }

  :deep(.el-dialog__body) {
      padding: 24px;
      color: var(--text-primary);
  }
  
  :deep(.el-dialog__footer) {
      padding: 16px 24px;
      background: rgba(0, 0, 0, 0.2);
      border-top: 1px solid rgba(255, 255, 255, 0.05);
  }


.dialog-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    
    .icon-wrapper {
        margin-bottom: 16px;
        position: relative;
        
        &::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 40px;
            height: 40px;
            background: var(--primary-gradient);
            filter: blur(20px);
            opacity: 0.4;
            border-radius: 50%;
        }
        
        .key-icon {
            width: 48px;
            height: 48px;
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--accent-color);
            font-size: 24px;
            position: relative;
            z-index: 1;
        }
    }
    
    h3 {
        margin: 0 0 8px;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
    }
    
    .dialog-desc {
        color: var(--text-secondary);
        margin: 0 0 24px;
        font-size: 14px;
        line-height: 1.5;
    }
    
    .input-group {
        width: 100%;
        text-align: left;
        
        label {
            display: block;
            font-size: 12px;
            font-weight: 500;
            color: var(--text-secondary);
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        
        .custom-input {
            :deep(.el-input__wrapper) {
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(255, 255, 255, 0.1);
                box-shadow: none;
                border-radius: 8px;
                padding: 4px 11px;
                transition: all 0.2s;
                
                &:hover, &.is-focus {
                    border-color: var(--accent-color);
                    background: rgba(0, 0, 0, 0.5);
                }
                
                .el-input__inner {
                    color: var(--text-primary);
                    height: 36px;
                    font-family: 'Fira Code', monospace;
                    font-size: 13px;
                    
                    &::placeholder {
                        color: #52525b;
                    }
                }
            }
            
            .input-icon {
                color: var(--text-secondary);
            }
        }
    }
}

.dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    
    .cancel-btn {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: var(--text-primary);
        
        &:hover {
            background: rgba(255, 255, 255, 0.05);
            border-color: rgba(255, 255, 255, 0.2);
        }
    }
    
    .save-btn {
        background: var(--primary-gradient);
        border: none;
        
        &:hover {
            opacity: 0.9;
            transform: translateY(-1px);
        }
    }
}

.chat-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 20px 0 140px;
  scroll-behavior: smooth;
  
  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background-color: var(--bg-hover);
    border-radius: 3px;
  }
  &::-webkit-scrollbar-track {
    background-color: transparent;
  }
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-primary);
  text-align: center;
  padding-bottom: 100px;
  
  .logo-container {
    margin-bottom: 32px;
    position: relative;
    
    &::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 120px;
      height: 120px;
      background: var(--primary-gradient);
      filter: blur(60px);
      opacity: 0.2;
      z-index: 0;
    }
    
    .logo {
      position: relative;
      width: 64px;
      height: 64px;
      background: var(--primary-gradient);
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: 800;
      color: white;
      box-shadow: 0 10px 30px rgba(124, 58, 237, 0.3);
      z-index: 1;
    }
  }
  
  h1 {
    font-size: 2rem;
    font-weight: 600;
    margin: 0 0 12px;
    letter-spacing: -0.02em;
  }
  
  .subtitle {
    color: var(--text-secondary);
    font-size: 1.1rem;
    margin: 0;
  }
}

.message-row {
  padding: 32px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
  
  &.assistant {
    background-color: transparent;
  }
  
  &.user {
    background-color: rgba(255,255,255,0.02);
  }
  
  .message-content-wrapper {
    max-width: 800px;
    margin: 0 auto;
    display: flex;
    gap: 24px;
    padding: 0 24px;
    
    @media (max-width: 768px) {
      padding: 0 16px;
      gap: 16px;
    }
  }
  
  .avatar {
    flex-shrink: 0;
    margin-top: 2px;
    
    .ai-avatar {
      width: 32px;
      height: 32px;
      background: var(--primary-gradient);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      color: white;
    }
    
    .user-avatar {
      background: var(--bg-hover);
      color: var(--text-secondary);
    }
  }
  
  .message-text {
    flex: 1;
    font-size: 1rem;
    line-height: 1.7;
    color: var(--text-primary);
    overflow-x: auto;
    
    .role-name {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 6px;
    }
    
    .user-content {
      white-space: pre-wrap;
    }
    
    :deep(.markdown-body) {
      color: var(--text-primary);
      
      h1, h2, h3, h4, h5, h6 {
        color: var(--text-primary);
        margin-top: 24px;
        margin-bottom: 16px;
        font-weight: 600;
      }
      
      p {
        margin-bottom: 16px;
        &:last-child {
          margin-bottom: 0;
        }
      }
      
      a {
        color: #38bdf8;
        text-decoration: none;
        &:hover {
          text-decoration: underline;
        }
      }
      
      pre {
        background: #000000;
        border: 1px solid var(--border-color);
        padding: 16px;
        border-radius: 8px;
        overflow-x: auto;
        margin: 16px 0;
        
        code {
          background: transparent;
          padding: 0;
          border-radius: 0;
          color: inherit;
        }
      }
      
      code {
        font-family: 'Fira Code', monospace;
        background: rgba(255,255,255,0.1);
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 0.9em;
      }

      ul, ol {
        padding-left: 24px;
        margin-bottom: 16px;
        
        li {
          margin-bottom: 8px;
        }
      }
      
      blockquote {
        border-left: 4px solid var(--accent-color);
        padding-left: 16px;
        color: var(--text-secondary);
        margin: 16px 0;
      }
    }
    
    .cursor {
      display: inline-block;
      width: 8px;
      height: 18px;
      background: var(--accent-color);
      vertical-align: text-bottom;
      margin-left: 4px;
      animation: blink 1s step-end infinite;
    }
  }
}

.input-container {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  background: linear-gradient(180deg, transparent 0%, var(--bg-app) 40%);
  padding: 40px 0 30px;
  z-index: 10;
  
  .input-wrapper {
    max-width: 800px;
    margin: 0 auto;
    padding: 0 24px;
    
    @media (max-width: 768px) {
      padding: 0 16px;
    }
  }
  
  .input-box {
    position: relative;
    background: var(--bg-card);
    border-radius: 16px;
    border: 1px solid var(--border-color);
    box-shadow: 0 0 20px rgba(0,0,0,0.2);
    display: flex;
    align-items: center;
    padding: 12px;
    transition: border-color 0.2s, box-shadow 0.2s;
    
    &:focus-within {
      border-color: var(--accent-color);
      box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.1);
    }
    
    textarea {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 1rem;
      line-height: 1.5;
      resize: none;
      max-height: 200px;
      padding: 10px;
      outline: none;
      
      &::placeholder {
        color: var(--text-secondary);
      }
    }
    
    .send-btn {
      width: 36px;
      height: 36px;
      background: var(--primary-gradient);
      border: none;
      color: white;
      border-radius: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      flex-shrink: 0;
      margin-bottom: 2px;
      
      &:hover:not(:disabled) {
        opacity: 0.9;
        transform: scale(1.05);
      }
      
      &:disabled {
        background: var(--bg-hover);
        color: var(--text-secondary);
        cursor: not-allowed;
      }
    }
  }
  
  .disclaimer {
    text-align: center;
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin-top: 12px;
  }
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
</style>
