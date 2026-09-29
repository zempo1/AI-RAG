<template>
  <div class="wb-section generate-section">
    <div v-if="fileName" class="active-file">
      <el-icon class="file-icon"><Document /></el-icon>
      <el-tooltip :content="fileName" placement="right" :show-after="400" :hide-after="0">
        <span class="file-name">{{ fileName }}</span>
      </el-tooltip>
    </div>
    <div v-else class="no-file">
      <el-icon><InfoFilled /></el-icon>
      <span>请先在左侧上传或激活文件</span>
    </div>
    <el-button class="generate-btn" type="primary"
      :disabled="disabled"
      :loading="loading"
      @click="$emit('generate')">
      <el-icon class="el-icon--left"><component :is="icon" /></el-icon>
      {{ buttonText }}
    </el-button>
  </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { Document, InfoFilled } from '@element-plus/icons-vue'

withDefaults(defineProps<{
  fileName: string
  buttonText: string
  icon: Component
  loading?: boolean
  disabled?: boolean
}>(), {
  loading: false,
  disabled: false,
})

defineEmits<{ (e: 'generate'): void }>()
</script>

<style scoped>
.wb-section {
  padding: 12px 12px 10px;
  flex-shrink: 0;
}

.generate-section {
  .active-file {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(139, 92, 246, 0.08);
    border: 1px solid rgba(139, 92, 246, 0.2);
    border-radius: 8px;
    padding: 7px 10px;
    margin-bottom: 10px;

    .file-icon {
      font-size: 14px;
      color: var(--accent-color);
      flex-shrink: 0;
    }

    .file-name {
      font-size: 0.8rem;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .no-file {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.78rem;
    color: var(--text-secondary);
    margin-bottom: 10px;

    .el-icon {
      font-size: 13px;
    }
  }

  .generate-btn {
    width: 100%;
    background: var(--primary-gradient);
    border: none;
    border-radius: 8px;
    font-size: 0.84rem;
    font-weight: 500;
    transition: opacity 0.2s, transform 0.1s;

    &:hover:not(:disabled) {
      opacity: 0.9;
      transform: translateY(-1px);
    }

    &:active:not(:disabled) {
      transform: translateY(0);
    }

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      background: var(--primary-gradient);
    }
  }
}
</style>