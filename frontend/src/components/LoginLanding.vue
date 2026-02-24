<template>
  <div class="landing-container">
    <!-- Background Accents -->
    <div class="bg-blob blob-1"></div>
    <div class="bg-blob blob-3"></div>

    <nav class="navbar">
      <div class="brand">
        <div class="ai-logo">AI</div>
        <span>AI-RAG</span>
      </div>
      <div class="nav-links">
        <el-button link @click="scrollTo('features')">特性</el-button>
        <el-button link @click="scrollTo('preview')">演示</el-button>
        <el-button type="primary" round class="nav-cta" @click="showAuth = true">立即开始</el-button>
      </div>
    </nav>

    <main class="hero-section">
      <div class="hero-content">
        <h1 class="hero-title">
          您的个人 <span class="gradient-text">知识大脑</span>
        </h1>
        <p class="hero-subtitle">
          上传您的文档，即刻开启基于私有数据的 AI 对话。支持流式响应、思维导图生成及多用户隔离。
        </p>
        <div class="hero-btns">
          <el-button type="primary" size="large" round class="main-btn" @click="showAuth = true">
            开始体验 <el-icon class="el-icon--right"><ArrowRight /></el-icon>
          </el-button>
          <el-button size="large" round class="secondary-btn" @click="scrollTo('preview')">
            查看演示
          </el-button>
        </div>
      </div>

      <!-- Chat Preview Window -->
      <div id="preview" class="preview-window">
        <div class="window-header">
          <div class="dots">
            <span></span><span></span><span></span>
          </div>
          <div class="window-title">AI 对话预览</div>
        </div>
        <div class="window-body">
          <div class="chat-msg user">
            <div class="avatar">U</div>
            <div class="bubble">你能帮我总结一下这个 PDF 文档的核心内容吗？</div>
          </div>
          <div class="chat-msg assistant">
            <div class="avatar ai">AI</div>
            <div class="bubble">
              <p>{{ streamingText }}<span class="cursor">|</span></p>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Features Section -->
    <section id="features" class="features-grid">
      <div class="feature-card">
        <div class="icon-box purple"><el-icon><Document /></el-icon></div>
        <h3>智能 RAG 检索</h3>
        <p>基于深度语义理解，精准定位文档信息，回答准确无误。</p>
      </div>
      <div class="feature-card">
        <div class="icon-box blue"><el-icon><Connection /></el-icon></div>
        <h3>思维导图生成</h3>
        <p>一键将长篇文档转化为结构清晰的思维导图，洞察核心逻辑。</p>
      </div>
      <div class="feature-card">
        <div class="icon-box orange"><el-icon><Lock /></el-icon></div>
        <h3>私有化隔离</h3>
        <p>数据严格加密，多用户完全隔离，保护您的每一份文档隐私。</p>
      </div>
    </section>

    <!-- Auth Overlay -->
    <Transition name="fade">
      <div v-if="showAuth" class="auth-overlay" @click.self="showAuth = false">
        <div class="auth-card">
          <div class="auth-header">
            <h2>{{ isLogin ? '登录' : '注册' }}</h2>
            <p>{{ isLogin ? '继续您的 AI 探索之路' : '创建账号，开启您的智能空间' }}</p>
          </div>
          
          <el-form :model="form" class="auth-form" @submit.prevent="handleAuth">
            <el-form-item>
              <el-input v-model="form.username" placeholder="用户名" prefix-icon="User" size="large" />
            </el-form-item>
            <el-form-item>
              <el-input v-model="form.password" type="password" placeholder="密码" prefix-icon="Lock" show-password size="large" />
            </el-form-item>
            <el-button type="primary" class="auth-btn" size="large" :loading="loading" @click="handleAuth">
              {{ isLogin ? '登录' : '注册' }}
            </el-button>
          </el-form>

          <div class="auth-footer">
            <span>{{ isLogin ? '还没有账号？' : '已有账号？' }}</span>
            <el-button link type="primary" @click="isLogin = !isLogin">
              {{ isLogin ? '立即注册' : '返回登录' }}
            </el-button>
          </div>
          
          <el-button class="close-btn" circle @click="showAuth = false">
            <el-icon><Close /></el-icon>
          </el-button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue'
import { ArrowRight, Document, Connection, Lock, User, Close } from '@element-plus/icons-vue'
import request from '../utils/request'
import { useToast } from '../composables/useToast'

const showAuth = ref(false)
const isLogin = ref(true)
const loading = ref(false)
const streamingText = ref('')
const fullText = '当然可以。根据您上传的文档，其核心内容主要涵盖了三个维度：首先是分布式系统的共识算法优化；其次是数据在多节点间的同步机制；最后是系统的高可用架构设计。'

const form = reactive({
  username: '',
  password: ''
})

const emit = defineEmits(['success'])
const toast = useToast()

let streamInterval: any = null

const startStreaming = () => {
  let index = 0
  streamingText.value = ''
  clearInterval(streamInterval)
  streamInterval = setInterval(() => {
    if (index < fullText.length) {
      streamingText.value += fullText[index]
      index++
    } else {
      setTimeout(() => {
        index = 0
        streamingText.value = ''
      }, 3000)
    }
  }, 100)
}

const handleAuth = async () => {
  if (!form.username || !form.password) {
    toast.warning('请输入用户名和密码')
    return
  }

  loading.value = true
  const endpoint = isLogin.value ? '/api/auth/login' : '/api/auth/register'
  
  try {
    const res: any = await request.post(endpoint, form)
    localStorage.setItem('token', res.token)
    localStorage.setItem('username', res.username)
    toast.success(isLogin.value ? '登录成功' : '注册成功')
    emit('success', res.username)
  } catch (e: any) {
    toast.error(e?.message || '操作失败')
  } finally {
    loading.value = false
  }
}

const scrollTo = (id: string) => {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

onMounted(() => {
  startStreaming()
})

onBeforeUnmount(() => {
  clearInterval(streamInterval)
})
</script>

<style scoped lang="scss">
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');

.landing-container {
  min-height: 100vh;
  background: #F8FAFC;
  font-family: 'Plus Jakarta Sans', sans-serif;
  color: #1E293B;
  position: relative;
  overflow: hidden; /* Changed from overflow-x: hidden to prevent vertical overflow from absolute elements */
  padding-top: 80px;
}

/* Blobs */
.bg-blob {
  position: absolute;
  filter: blur(80px);
  z-index: 0;
  opacity: 0.4;
  border-radius: 50%;
}
.blob-1 {
  width: 400px;
  height: 400px;
  background: #3B82F6;
  top: -100px;
  right: -100px;
}
.blob-3 {
  width: 300px;
  height: 300px;
  background: #F97316;
  top: 40%;
  left: 10%;
}

.navbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 80px;
  background: rgba(248, 252, 252, 0.8);
  backdrop-filter: blur(12px);
  z-index: 100;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    font-weight: 800;
    font-size: 22px;
    color: #1E293B;

    .ai-logo {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 18px;
      box-shadow: 0 8px 16px rgba(59, 130, 246, 0.3);
    }
  }

  .nav-links {
    display: flex;
    align-items: center;
    gap: 32px;

    .el-button--link {
      color: #64748B;
      font-weight: 600;
      &:hover { color: #3B82F6; }
    }

    .nav-cta {
      padding: 0 24px;
      height: 44px;
      font-weight: 700;
      background: #1E293B;
      border: none;
      &:hover { background: #334155; transform: translateY(-1px); }
    }
  }
}

.hero-section {
  max-width: 1200px;
  margin: 0 auto;
  padding: 100px 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  position: relative;
  z-index: 1;

  .hero-content {
    max-width: 800px;
    margin-bottom: 80px;

    .hero-title {
      font-size: 72px;
      font-weight: 800;
      line-height: 1.1;
      margin-bottom: 24px;
      letter-spacing: -0.04em;

      .gradient-text {
        background: linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
    }

    .hero-subtitle {
      font-size: 20px;
      color: #64748B;
      line-height: 1.6;
      margin-bottom: 40px;
    }

    .hero-btns {
      display: flex;
      gap: 16px;
      justify-content: center;

      .main-btn {
        height: 56px;
        padding: 0 40px;
        font-size: 18px;
        font-weight: 700;
        background: #3B82F6;
        border: none;
        box-shadow: 0 10px 20px rgba(59, 130, 246, 0.2);
        &:hover { transform: translateY(-2px); box-shadow: 0 15px 30px rgba(59, 130, 246, 0.3); }
      }

      .secondary-btn {
        height: 56px;
        padding: 0 40px;
        font-size: 18px;
        font-weight: 700;
        border: 2px solid #E2E8F0;
        background: white;
        color: #1E293B;
        &:hover { border-color: #3B82F6; color: #3B82F6; }
      }
    }
  }
}

.preview-window {
  width: 100%;
  max-width: 900px;
  background: white;
  border-radius: 20px;
  border: 1px solid #E2E8F0;
  box-shadow: 0 40px 80px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  text-align: left;

  .window-header {
    background: #F8FAFC;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid #E2E8F0;

    .dots {
      display: flex;
      gap: 8px;
      span {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        &:nth-child(1) { background: #FF5F56; }
        &:nth-child(2) { background: #FFBD2E; }
        &:nth-child(3) { background: #27C93F; }
      }
    }

    .window-title {
      flex: 1;
      text-align: center;
      font-size: 14px;
      font-weight: 600;
      color: #94A3B8;
    }
  }

  .window-body {
    padding: 32px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    min-height: 300px;

    .chat-msg {
      display: flex;
      gap: 16px;
      max-width: 80%;

      .avatar {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        background: #E2E8F0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        font-size: 14px;
        flex-shrink: 0;

        &.ai {
          background: linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%);
          color: white;
        }
      }

      .bubble {
        padding: 12px 20px;
        border-radius: 18px;
        font-size: 15px;
        line-height: 1.6;
      }

      &.user {
        align-self: flex-end;
        flex-direction: row-reverse;
        .bubble { background: #F1F5F9; color: #1E293B; border-bottom-right-radius: 4px; }
      }

      &.assistant {
        .bubble { background: white; border: 1px solid #E2E8F0; color: #334155; border-bottom-left-radius: 4px; }
      }

      .cursor {
        display: inline-block;
        width: 2px;
        background: #3B82F6;
        margin-left: 2px;
        animation: blink 1s infinite;
      }
    }
  }
}

.features-grid {
  max-width: 1200px;
  margin: 0 auto;
  padding: 100px 40px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 32px;
  z-index: 1;
  position: relative;

  .feature-card {
    background: white;
    padding: 40px;
    border-radius: 24px;
    border: 1px solid #E2E8F0;
    transition: all 0.3s;
    &:hover { transform: translateY(-8px); border-color: #3B82F6; box-shadow: 0 20px 40px rgba(0, 0, 0, 0.05); }

    .icon-box {
      width: 56px;
      height: 56px;
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      margin-bottom: 24px;

      &.purple { background: #F5F3FF; color: #8B5CF6; }
      &.blue { background: #EFF6FF; color: #3B82F6; }
      &.orange { background: #FFF7ED; color: #F97316; }
    }

    h3 { font-size: 22px; font-weight: 700; margin-bottom: 16px; }
    p { color: #64748B; line-height: 1.6; }
  }
}

/* Auth Overlay */
.auth-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(15, 23, 42, 0.8);
  backdrop-filter: blur(8px);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.auth-card {
  width: 100%;
  max-width: 440px;
  background: white;
  border-radius: 32px;
  padding: 48px;
  position: relative;
  box-shadow: 0 40px 100px rgba(0, 0, 0, 0.2);

  .auth-header {
    text-align: center;
    margin-bottom: 40px;
    h2 { font-size: 32px; font-weight: 800; margin-bottom: 12px; }
    p { color: #64748B; }
  }

  .auth-btn {
    width: 100%;
    height: 56px;
    font-size: 18px;
    font-weight: 700;
    border-radius: 16px;
    background: #1E293B;
    border: none;
    margin-top: 24px;
    &:hover { background: #334155; }
  }

  .auth-footer {
    text-align: center;
    margin-top: 32px;
    font-size: 15px;
    color: #64748B;
    .el-button { font-weight: 700; }
  }

  .close-btn {
    position: absolute;
    top: 24px;
    right: 24px;
    border: none;
    background: #F1F5F9;
    color: #64748B;
    &:hover { background: #E2E8F0; color: #1E293B; }
  }
}

:deep(.el-input__wrapper) {
  background: #F8FAFC;
  box-shadow: none;
  border: 1px solid #E2E8F0;
  border-radius: 16px;
  padding: 12px 16px;
  &.is-focus { border-color: #3B82F6; background: white; }
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

@media (max-width: 1024px) {
  .hero-section .hero-title { font-size: 56px; }
  .features-grid { grid-template-columns: 1fr; }
  .navbar { padding: 0 40px; }
}
</style>
