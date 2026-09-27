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
        <el-button type="primary" round class="nav-cta" @click="showAuth = true"
          >立即开始</el-button
        >
      </div>
    </nav>

    <main class="hero-section">
      <div class="hero-content">
        <h1 class="hero-title">
          您的个人 <span class="gradient-text">知识大脑</span>
        </h1>
        <p class="hero-subtitle">
          上传您的文档，即刻开启基于私有数据的 AI
          对话。支持流式响应、思维导图生成及多用户隔离。
        </p>
        <div class="hero-btns">
          <el-button
            type="primary"
            size="large"
            round
            class="main-btn"
            @click="showAuth = true"
          >
            开始体验 <el-icon class="el-icon--right"><ArrowRight /></el-icon>
          </el-button>
          <el-button
            size="large"
            round
            class="secondary-btn"
            @click="scrollTo('preview')"
          >
            查看演示
          </el-button>
        </div>
      </div>

      <!-- Chat Preview Window -->
      <div id="preview" class="preview-window">
        <div class="window-header">
          <div class="dots"><span></span><span></span><span></span></div>
          <div class="window-title">AI 对话预览</div>
        </div>
        <div class="window-body">
          <div class="chat-msg user">
            <div class="avatar">U</div>
            <div class="bubble">
              你能帮我总结一下这个 PDF 文档的核心内容吗？
            </div>
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
        <div class="icon-box purple">
          <el-icon><Document /></el-icon>
        </div>
        <h3>智能 RAG 检索</h3>
        <p>基于深度语义理解，精准定位文档信息，回答准确无误。</p>
      </div>
      <div class="feature-card">
        <div class="icon-box blue">
          <el-icon><Connection /></el-icon>
        </div>
        <h3>思维导图生成</h3>
        <p>一键将长篇文档转化为结构清晰的思维导图，洞察核心逻辑。</p>
      </div>
      <div class="feature-card">
        <div class="icon-box orange">
          <el-icon><Lock /></el-icon>
        </div>
        <h3>私有化隔离</h3>
        <p>数据严格加密，多用户完全隔离，保护您的每一份文档隐私。</p>
      </div>
    </section>

    <!-- Auth Overlay -->
    <Transition name="fade">
      <div v-if="showAuth" class="auth-overlay" @click.self="showAuth = false">
        <div class="auth-card">
          <div class="auth-header">
            <h2>{{ isLogin ? "登录" : "注册" }}</h2>
            <p>
              {{
                isLogin ? "继续您的 AI 探索之路" : "创建账号，开启您的智能空间"
              }}
            </p>
          </div>

          <el-form :model="form" class="auth-form" @submit.prevent="handleAuth">
            <el-form-item>
              <el-input
                v-model="form.username"
                placeholder="用户名"
                prefix-icon="User"
                size="large"
              />
            </el-form-item>
            <el-form-item>
              <el-input
                v-model="form.password"
                type="password"
                placeholder="密码"
                prefix-icon="Lock"
                show-password
                size="large"
              />
            </el-form-item>
            <el-button
              type="primary"
              class="auth-btn"
              size="large"
              :loading="loading"
              @click="handleAuth"
            >
              {{ isLogin ? "登录" : "注册" }}
            </el-button>
          </el-form>

          <div class="auth-footer">
            <span>{{ isLogin ? "还没有账号？" : "已有账号？" }}</span>
            <el-button link type="primary" @click="isLogin = !isLogin">
              {{ isLogin ? "立即注册" : "返回登录" }}
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
import { ref, reactive, onMounted, onBeforeUnmount } from "vue";
import {
  ArrowRight,
  Document,
  Connection,
  Lock,
  User,
  Close,
} from "@element-plus/icons-vue";
import request from "../../utils/request";
import { useToast } from "../../composables/useToast";

const showAuth = ref(false);
const isLogin = ref(true);
const loading = ref(false);
const streamingText = ref("");
const fullText =
  "当然可以。根据您上传的文档，其核心内容主要涵盖了三个维度：首先是分布式系统的共识算法优化；其次是数据在多节点间的同步机制；最后是系统的高可用架构设计。";

const form = reactive({
  username: "",
  password: "",
});

const emit = defineEmits(["success"]);
const toast = useToast();

let streamInterval: any = null;

const startStreaming = () => {
  let index = 0;
  streamingText.value = "";
  clearInterval(streamInterval);
  streamInterval = setInterval(() => {
    if (index < fullText.length) {
      streamingText.value += fullText[index];
      index++;
    } else {
      setTimeout(() => {
        index = 0;
        streamingText.value = "";
      }, 3000);
    }
  }, 100);
};

const handleAuth = async () => {
  if (!form.username || !form.password) {
    toast.warning("请输入用户名和密码");
    return;
  }

  loading.value = true;
  const endpoint = isLogin.value ? "/api/auth/login" : "/api/auth/register";

  try {
    const res: any = await request.post(endpoint, form);
    localStorage.setItem("token", res.token);
    localStorage.setItem("username", res.username);
    toast.success(isLogin.value ? "登录成功" : "注册成功");
    emit("success", res.username);
  } catch (e: any) {
    toast.error(e?.response?.data?.message || e?.message || "操作失败");
  } finally {
    loading.value = false;
  }
};

const scrollTo = (id: string) => {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
};

onMounted(() => {
  startStreaming();
});

onBeforeUnmount(() => {
  clearInterval(streamInterval);
});
</script>

<style lang="scss" src="./LoginLanding.scss" scoped></style>