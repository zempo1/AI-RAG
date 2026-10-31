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
      <span>请在文档管理中选择“用于工作台”</span>
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

<style lang="scss" scoped>
  @use './GenerateSection.scss';
</style>
