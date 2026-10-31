<template>
  <section class="library-picker knowledge-theme">
    <el-select
      :model-value="knowledgeBaseId"
      placeholder="选择知识库"
      :disabled="uploading"
      popper-class="knowledge-theme knowledge-popper library-options"
      :show-arrow="false"
      @change="emit('change', $event)"
      :title="currentLibrary?.name"
    >
      <template #prefix
        ><el-icon><Collection /></el-icon
      ></template>
      <el-option
        v-for="kb in libraries"
        :key="kb.id"
        :label="kb.name"
        :value="kb.id"
        ><span class="library-option-name">{{ kb.name }}</span
        ><el-icon v-if="kb.id === knowledgeBaseId" class="library-option-check"
          ><Check /></el-icon
      ></el-option>
      <el-option
        v-if="knowledgeBaseId && !currentLibrary"
        :value="knowledgeBaseId"
        label="已删除知识库（历史会话）"
        disabled
      />
    </el-select>
    <div class="picker-actions">
      <el-button
        class="manage-button"
        :disabled="!currentLibrary"
        @click="emit('manage')"
        ><el-icon><FolderOpened /></el-icon>管理文档</el-button
      >
      <el-button
        class="create-button"
        title="新建知识库"
        aria-label="新建知识库"
        @click="emit('create')"
        ><el-icon><Plus /></el-icon
      ></el-button>
    </div>
    <p class="library-hint">问答检索当前知识库</p>
    <div class="selected-source" :title="selectedDocument?.filename">
      <el-icon><Document /></el-icon>
      <div>
        <span class="source-label">工作台来源</span
        ><span class="source-name">{{
          selectedDocument?.filename || "在文档管理中选择文档"
        }}</span>
      </div>
      <el-button
        v-if="selectedDocument"
        class="clear-source"
        title="取消使用"
        aria-label="取消使用"
        @click="emit('clear')"
        ><el-icon><Close /></el-icon
      ></el-button>
    </div>
  </section>
</template>
<script setup lang="ts">
import {
  Collection,
  FolderOpened,
  Plus,
  Document,
  Check,
  Close,
} from "@element-plus/icons-vue";
import type { KnowledgeBase, ManagedDocument } from "../../api/knowledge-bases";
defineProps<{
  knowledgeBaseId: number | null;
  libraries: KnowledgeBase[];
  currentLibrary?: KnowledgeBase;
  selectedDocument: ManagedDocument | null;
  uploading: boolean;
}>();
const emit = defineEmits<{
  (e: "change", id: number): void;
  (e: "manage"): void;
  (e: "create"): void;
  (e: "clear"): void;
}>();
</script>
