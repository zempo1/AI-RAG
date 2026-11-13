<template>
  <div class="document-list">
    <div class="document-head" aria-hidden="true">
      <span>文档</span><span>分类</span><span>处理状态</span><span>操作</span>
    </div>
    <ul>
      <li
        v-for="doc in documents"
        :key="doc.id"
        class="document-card"
        :class="{ 'is-selected': documentId === doc.id }"
      >
        <div class="document-name">
          <el-icon class="file-symbol"><Document /></el-icon>
          <div>
            <button class="document-preview-name" type="button" :title="doc.filename" :aria-label="'预览 ' + doc.filename" @click="emit('action', 'preview', doc)">{{ doc.filename }}</button
            ><span class="muted">{{
              doc.activeIndexRevisionId ? "已有可用索引" : "尚未建立可用索引"
            }}</span>
          </div>
        </div>
        <el-select
          :model-value="doc.categoryId"
          placeholder="未分类"
          clearable
          :disabled="locked"
          popper-class="knowledge-theme knowledge-popper"
          :aria-label="doc.filename + '的分类'"
          @change="emit('classify', doc, $event)"
        >
          <el-option
            v-for="cat in categories"
            :key="cat.id"
            :label="cat.name"
            :value="cat.id"
          />
        </el-select>
        <div class="document-state" :class="'state-' + doc.status">
          <span class="status-label"
            ><el-icon
              ><CircleCheck v-if="doc.status === 'ready'" /><Warning
                v-else-if="doc.status === 'failed'" /><Clock v-else /></el-icon
            >{{ stateLabel(doc) }}</span
          >
          <IndexProgressDetails
            v-if="doc.task && ['queued', 'running', 'retrying'].includes(doc.task.status)"
            :progress="doc.task.indexProgress"
          />
          <el-progress
            v-if="doc.task && !doc.task.indexProgress && !terminal(doc.task.status) && doc.task.total"
            :percentage="
              Math.min(
                100,
                Math.round((doc.task.completed / doc.task.total) * 100),
              )
            "
            :stroke-width="4"
            :show-text="false"
          />
          <div v-else-if="doc.task?.status === 'running' && !doc.task.indexProgress?.pages.total" class="index-progress-unknown"
            role="progressbar" aria-label="文档解析进度"
            :aria-valuetext="['vision', 'ocr'].includes(doc.task.stage) ? `已识别 ${doc.task.completed} 个区域，总量统计中` : '正在处理，总量统计中'">
            <span></span>
          </div>
          <div v-if="doc.task?.error" class="error-text">
            {{ doc.task.error }}
          </div>
          <div
            v-if="doc.status === 'failed' && doc.activeIndexRevisionId"
            class="muted"
          >
            更新失败，问答继续使用旧版
          </div>
          <el-button
            v-if="
              doc.task?.status === 'failed' &&
              doc.task.retryable &&
              !doc.task.parentTaskId
            "
            link
            class="retry-button"
            @click="emit('retry', doc.task)"
            >重试</el-button
          >
        </div>
        <div class="document-actions">
          <el-button
            link
            class="use-document"
            :disabled="!doc.activeIndexRevisionId"
            @click="emit('action', 'activate', doc)"
            >{{
              documentId === doc.id ? "已用于工作台" : "用于工作台"
            }}</el-button
          >
          <el-dropdown
            trigger="click"
            popper-class="knowledge-theme knowledge-popper"
            @command="emit('action', $event, doc)"
          >
            <el-button
              class="icon-button"
              :aria-label="doc.filename + '的更多操作'"
              title="更多操作"
              ><el-icon><MoreFilled /></el-icon
            ></el-button>
            <template #dropdown
              ><el-dropdown-menu>
                <el-dropdown-item command="preview">预览</el-dropdown-item>
                <el-dropdown-item
                  command="replace"
                  :disabled="uploading || locked"
                  >替换</el-dropdown-item
                >
                <el-dropdown-item command="rename" :disabled="locked"
                  >重命名</el-dropdown-item
                >
                <el-dropdown-item command="reindex" :disabled="locked"
                  >重建</el-dropdown-item
                >
                <el-dropdown-item command="delete" divided class="danger-item"
                  >删除</el-dropdown-item
                >
              </el-dropdown-menu></template
            >
          </el-dropdown>
        </div>
      </li>
    </ul>
  </div>
</template>
<script setup lang="ts">
import {
  Document,
  CircleCheck,
  Warning,
  Clock,
  MoreFilled,
} from "@element-plus/icons-vue";
import type {
  Category,
  ManagedDocument,
  ProcessingTask,
} from "../../api/knowledge-bases";
import IndexProgressDetails from "./IndexProgressDetails.vue";
defineProps<{
  documents: ManagedDocument[];
  categories: Category[];
  documentId: number | null;
  locked: boolean;
  uploading: boolean;
  stateLabel: (doc: ManagedDocument) => string;
}>();
const emit = defineEmits<{
  (e: "action", action: string, doc: ManagedDocument): void;
  (e: "classify", doc: ManagedDocument, category?: number): void;
  (e: "retry", task: ProcessingTask): void;
}>();
const terminal = (status: string) =>
  ["completed", "failed", "partial_failed", "canceled"].includes(status);
</script>

<style scoped>
.document-preview-name { display:block; border:0; padding:0; background:transparent; color:inherit; font:inherit; font-weight:600; max-width:100%; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
.document-preview-name:hover { color:var(--el-color-primary); text-decoration:underline; }
.document-preview-name:focus-visible { outline:2px solid var(--el-color-primary); outline-offset:4px; }
.index-progress-unknown { height: 4px; overflow: hidden; border-radius: 4px; background: var(--el-fill-color-light); position: relative; margin-top: 8px; }
.index-progress-unknown span { position: absolute; height: 100%; width: 35%; border-radius: inherit; background: var(--el-color-primary); animation: index-progress 1.6s linear infinite; }
@keyframes index-progress { from { left: -35%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .index-progress-unknown span { animation: none; left: 32%; } }
</style>
