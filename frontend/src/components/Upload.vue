<template>
  <div class="upload-container">
    <!-- 上传区域 -->
    <div v-if="!isUploaded && !isUploading">
      <el-upload
        class="upload-demo"
        drag
        :auto-upload="false"
        :show-file-list="false"
        :before-upload="() => false"
        :on-change="handleFileChange"
        accept=".pdf,.md"
      >
        <el-icon class="el-icon--upload"><upload-filled /></el-icon>
        <div class="el-upload__text">
          将文件拖到此处，或 <em>点击上传</em>
        </div>
        <template #tip>
          <div class="el-upload__tip">支持 PDF/Markdown，支持断点续传</div>
        </template>
      </el-upload>
    </div>

    <!-- 上传进度 -->
    <div v-if="isUploading" class="uploading-state">
      <div class="upload-info">
        <el-icon class="uploading-icon" :class="{ 'is-paused': isPaused }">
          <Loading v-if="!isPaused" />
          <VideoPause v-else />
        </el-icon>
        <span class="filename">{{ pendingFile?.name }}</span>
      </div>
      <div class="progress-wrap">
        <el-progress
          :percentage="totalProgress"
          :status="progressStatus"
          :striped="!isPaused"
          :striped-flow="!isPaused"
          :duration="10"
          stroke-width="8"
        />
        <span class="progress-label">{{ statusText }}</span>
      </div>
      <div class="upload-actions">
        <el-button v-if="!isPaused" size="small" @click="pauseUpload">
          <el-icon><VideoPause /></el-icon> 暂停
        </el-button>
        <el-button v-else type="primary" size="small" @click="resumeUpload">
          <el-icon><VideoPlay /></el-icon> 继续
        </el-button>
        <el-button size="small" type="danger" @click="cancelUpload">取消</el-button>
      </div>
    </div>

    <!-- 已上传状态 -->
    <div v-if="isUploaded" class="uploaded-state">
      <div class="file-info">
        <el-icon class="success-icon"><CircleCheckFilled /></el-icon>
        <span class="filename">{{ uploadedFileName }}</span>
      </div>
      <div class="actions">
        <el-button type="danger" circle size="small" @click="resetUpload">
          <el-icon><Close /></el-icon>
        </el-button>
      </div>
    </div>

    <!-- 历史文件列表 -->
    <div class="history-section" v-if="!isUploading">
      <div class="history-header" @click="historyExpanded = !historyExpanded">
        <span class="history-title">
          <el-icon><FolderOpened /></el-icon>
          历史文件
          <span class="history-count" v-if="docHistory.length > 0">{{ docHistory.length }}</span>
        </span>
        <el-icon class="toggle-icon" :class="{ rotated: historyExpanded }">
          <ArrowRight />
        </el-icon>
      </div>

      <transition name="slide">
        <div class="history-list" v-if="historyExpanded">
          <div v-if="historyLoading" class="history-empty">加载中…</div>
          <div v-else-if="docHistory.length === 0" class="history-empty">暂无历史文件</div>
          <div
            v-for="doc in docHistory"
            :key="doc.id"
            class="history-item"
            :class="{ active: uploadedFileName === doc.filename && isUploaded }"
          >
            <el-icon class="doc-icon"><Document /></el-icon>
            <div class="doc-info">
              <el-tooltip :content="doc.filename" placement="right" :show-after="400" :hide-after="0">
                <span class="doc-name">{{ doc.filename }}</span>
              </el-tooltip>
              <span class="doc-time">{{ formatTime(doc.uploadTime) }}</span>
            </div>
            <div class="doc-actions">
              <el-tooltip content="使用此文件" placement="top">
                <el-button
                  size="small"
                  circle
                  :loading="activatingId === doc.id"
                  @click.stop="handleActivate(doc)"
                >
                  <el-icon><Check /></el-icon>
                </el-button>
              </el-tooltip>
              <el-tooltip content="删除记录" placement="top">
                <el-button
                  size="small"
                  circle
                  type="danger"
                  @click.stop="handleDeleteDoc(doc)"
                >
                  <el-icon><Delete /></el-icon>
                </el-button>
              </el-tooltip>
            </div>
          </div>
        </div>
      </transition>
    </div>
  </div>

</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  UploadFilled,
  CircleCheckFilled,
  Close,
  Loading,
  VideoPause,
  VideoPlay,
  FolderOpened,
  ArrowRight,
  Document,
  Check,
  Delete,
} from '@element-plus/icons-vue'
import type { UploadFile } from 'element-plus'
import SparkMD5 from 'spark-md5'
import { useToast } from '../composables/useToast'
import { checkUpload, uploadChunk, mergeChunks } from '../api/upload'
import {
  listDocuments,
  activateDocument,
  deleteDocument,
  type DocumentSummary,
} from '../api/documents'

// ——— 常量 ———
const CHUNK_SIZE = 5 * 1024 * 1024
const CONCURRENCY = 3

// ——— 状态 ———
const isUploaded = ref(false)
const isUploading = ref(false)
const uploadedFileName = ref('')
const pendingFile = ref<File | null>(null)
const isPaused = ref(false)
const totalProgress = ref(0)
const statusText = ref('')

// 历史文件
const docHistory = ref<DocumentSummary[]>([])
const historyExpanded = ref(true)
const historyLoading = ref(false)
const activatingId = ref<number | null>(null)

let abortFlag = false
let uploadedChunkSet = new Set<number>()

const emit = defineEmits<{
  (e: 'activated', filename: string, id: number | null): void
}>()
const toast = useToast()

const progressStatus = computed(() => {
  if (totalProgress.value === 100) return 'success'
  if (isPaused.value) return 'warning'
  return ''
})

// ——— 时间格式化 ———
function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 0) return '今天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays} 天前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

// ——— 加载历史 ———
const loadHistory = async () => {
  historyLoading.value = true
  try {
    docHistory.value = await listDocuments()
  } catch (e) {
    console.error(e)
  } finally {
    historyLoading.value = false
  }
}

onMounted(() => loadHistory())

// ——— 激活历史文件 ———
const handleActivate = async (doc: DocumentSummary) => {
  activatingId.value = doc.id
  try {
    await activateDocument(doc.id)
    isUploaded.value = true
    uploadedFileName.value = doc.filename
    emit('activated', doc.filename, doc.id)
    toast.success(`已切换到「${doc.filename}」`)
  } catch (e) {
    console.error(e)
    toast.error('激活失败，请重试')
  } finally {
    activatingId.value = null
  }
}

// ——— 删除历史记录 ———
const handleDeleteDoc = async (doc: DocumentSummary) => {
  try {
    await deleteDocument(doc.id)
    docHistory.value = docHistory.value.filter((d) => d.id !== doc.id)
    if (uploadedFileName.value === doc.filename) resetUpload()
    toast.success('已删除记录')
  } catch (e) {
    console.error(e)
    toast.error('删除失败')
  }
}

// ——— 文件上传 ———
const handleFileChange = async (uploadFile: UploadFile) => {
  const file = uploadFile.raw
  if (!file) return
  const isValidType = file.type === 'application/pdf' || file.name.endsWith('.md')
  if (!isValidType) {
    toast.error('文件必须是 PDF 或 Markdown 格式！')
    return
  }
  pendingFile.value = file
  await startChunkUpload(file)
}

function calcMD5(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const spark = new SparkMD5.ArrayBuffer()
    const reader = new FileReader()
    const chunkCount = Math.ceil(file.size / CHUNK_SIZE)
    let currentChunk = 0
    const loadNext = () => {
      const start = currentChunk * CHUNK_SIZE
      reader.readAsArrayBuffer(file.slice(start, Math.min(start + CHUNK_SIZE, file.size)))
    }
    reader.onload = (e) => {
      spark.append(e.target!.result as ArrayBuffer)
      currentChunk++
      if (currentChunk < chunkCount) {
        totalProgress.value = Math.round((currentChunk / chunkCount) * 20)
        statusText.value = `计算文件指纹… ${totalProgress.value}%`
        loadNext()
      } else {
        resolve(spark.end())
      }
    }
    reader.onerror = reject
    loadNext()
  })
}

async function startChunkUpload(file: File) {
  isUploading.value = true
  abortFlag = false
  isPaused.value = false
  totalProgress.value = 0
  uploadedChunkSet = new Set()

  try {
    statusText.value = '计算文件指纹…'
    const md5 = await calcMD5(file)

    statusText.value = '检查文件状态…'
    const { uploaded, uploadedChunks = [] } = await checkUpload(md5, file.name)

    if (uploaded) {
      toast.success('⚡ 秒传成功！')
      finishUpload(file.name)
      return
    }

    uploadedChunkSet = new Set(uploadedChunks)
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    const pendingIndexes = Array.from({ length: totalChunks }, (_, i) => i).filter(
      (i) => !uploadedChunkSet.has(i),
    )
    let doneChunks = uploadedChunks.length

    const uploadSingle = async (index: number) => {
      if (abortFlag) return
      while (isPaused.value && !abortFlag) await sleep(300)
      if (abortFlag) return
      const start = index * CHUNK_SIZE
      const blob = file.slice(start, Math.min(start + CHUNK_SIZE, file.size))
      await uploadChunk(blob, md5, index, totalChunks, file.name)
      uploadedChunkSet.add(index)
      doneChunks++
      totalProgress.value = 20 + Math.round((doneChunks / totalChunks) * 75)
      statusText.value = `上传中… ${doneChunks}/${totalChunks} 片`
    }

    await asyncPool(CONCURRENCY, pendingIndexes, uploadSingle)
    if (abortFlag) return

    statusText.value = '服务器合并处理中…'
    totalProgress.value = 96
    await mergeChunks(md5, file.name, totalChunks)

    totalProgress.value = 100
    toast.success('文件处理成功！')
    await sleep(600)
    finishUpload(file.name)
    // 上传完成后重新加载历史以获取新文件 ID
    await loadHistory()
    const latest = docHistory.value[0]
    emit('activated', file.name, latest?.id ?? null)
  } catch (e: any) {
    if (!abortFlag) {
      console.error(e)
      toast.error('上传失败：' + (e?.response?.data?.error ?? e?.message ?? '未知错误'))
      cancelUpload()
    }
  }
}

const pauseUpload = () => { isPaused.value = true; statusText.value = '已暂停' }
const resumeUpload = () => { isPaused.value = false; statusText.value = '恢复上传…' }
const cancelUpload = () => {
  abortFlag = true
  isPaused.value = false
  isUploading.value = false
  pendingFile.value = null
  totalProgress.value = 0
  statusText.value = ''
  uploadedChunkSet = new Set()
}
const finishUpload = (name: string) => {
  isUploading.value = false
  isUploaded.value = true
  uploadedFileName.value = name
}
const resetUpload = () => {
  isUploaded.value = false
  uploadedFileName.value = ''
}

// ——— 工具 ———
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
async function asyncPool<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  const executing: Promise<void>[] = []
  for (const item of items) {
    const p = fn(item).then(() => { executing.splice(executing.indexOf(p), 1) })
    executing.push(p)
    if (executing.length >= concurrency) await Promise.race(executing)
  }
  await Promise.all(executing)
}
</script>

<style scoped lang="scss">
.upload-container {
  padding: 0 10px;
  display: flex;
  flex-direction: column;
  gap: 12px;

  :deep(.el-upload) { width: 100%; }
  :deep(.el-upload-dragger) {
    background: rgba(255, 255, 255, 0.02);
    border: 1px dashed var(--border-color);
    padding: 28px 16px;
    height: auto;
    border-radius: 12px;
    transition: all 0.2s;
    &:hover { border-color: var(--accent-color); background-color: var(--bg-hover); }
    &.is-dragover { background-color: rgba(139, 92, 246, 0.1); border-color: var(--accent-color); }
  }
  :deep(.el-icon--upload) {
    font-size: 40px;
    color: var(--text-secondary);
    margin-bottom: 12px;
    transition: color 0.2s;
  }
  :deep(.el-upload-dragger:hover .el-icon--upload) { color: var(--accent-color); }
  :deep(.el-upload__text) {
    color: var(--text-primary);
    font-size: 0.875rem;
    em { color: var(--accent-color); font-style: normal; font-weight: 600; }
  }
  :deep(.el-upload__tip) {
    color: var(--text-secondary);
    font-size: 0.75rem;
    margin-top: 8px;
    text-align: center;
  }

  // ——— 上传中 ———
  .uploading-state {
    background: rgba(139, 92, 246, 0.06);
    border: 1px solid rgba(139, 92, 246, 0.2);
    border-radius: 12px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;

    .upload-info {
      display: flex;
      align-items: center;
      gap: 10px;
      overflow: hidden;
      .uploading-icon {
        font-size: 18px;
        color: var(--accent-color);
        flex-shrink: 0;
        animation: spin 1.2s linear infinite;
        &.is-paused { animation: none; color: #f59e0b; }
      }
      .filename {
        color: var(--text-primary);
        font-size: 0.85rem;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
    .progress-wrap {
      display: flex;
      flex-direction: column;
      gap: 4px;
      .progress-label { font-size: 0.75rem; color: var(--text-secondary); text-align: right; }
    }
    .upload-actions { display: flex; gap: 8px; justify-content: flex-end; }
  }

  // ——— 已上传 ———
  .uploaded-state {
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.2);
    border-radius: 12px;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;

    .file-info {
      display: flex;
      align-items: center;
      gap: 12px;
      overflow: hidden;
      flex: 1;
      .success-icon { color: #10b981; font-size: 20px; flex-shrink: 0; }
      .filename {
        color: var(--text-primary);
        font-size: 0.875rem;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
    .actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    :deep(.el-button--danger) {
      background: transparent;
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: #ef4444;
      &:hover { background: #ef4444; color: white; border-color: #ef4444; }
    }
  }

  // ——— 历史文件 ———
  .history-section {
    border: 1px solid var(--border-color);
    border-radius: 10px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.02);

    .history-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 9px 12px;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s;
      &:hover { background: var(--bg-hover); }

      .history-title {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--text-secondary);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        .el-icon { font-size: 14px; }
        .history-count {
          background: var(--accent-color);
          color: white;
          font-size: 0.65rem;
          padding: 1px 5px;
          border-radius: 10px;
          font-weight: 700;
          line-height: 1.4;
        }
      }

      .toggle-icon {
        font-size: 12px;
        color: var(--text-secondary);
        transition: transform 0.2s;
        &.rotated { transform: rotate(90deg); }
      }
    }

    .history-list {
      border-top: 1px solid var(--border-color);
      max-height: 260px;
      overflow-y: auto;

      .history-empty {
        padding: 16px 12px;
        font-size: 0.8rem;
        color: var(--text-secondary);
        text-align: center;
      }

      .history-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        transition: background 0.15s;
        border-bottom: 1px solid rgba(255, 255, 255, 0.03);
        cursor: default;

        &:last-child { border-bottom: none; }
        &:hover { background: var(--bg-hover); }
        &.active { background: rgba(16, 185, 129, 0.08); }

        .doc-icon { font-size: 16px; color: var(--text-secondary); flex-shrink: 0; }

        .doc-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
          .doc-name {
            font-size: 0.82rem;
            color: var(--text-primary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .doc-time { font-size: 0.7rem; color: var(--text-secondary); }
        }

        .doc-actions {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
          opacity: 0;
          transition: opacity 0.15s;
          :deep(.el-button) {
            padding: 4px;
            width: 26px;
            height: 26px;
            font-size: 12px;
          }
        }
        &:hover .doc-actions { opacity: 1; }
      }
    }
  }
}

// 展开动画
.slide-enter-active, .slide-leave-active { transition: all 0.2s ease; max-height: 300px; }
.slide-enter-from, .slide-leave-to { max-height: 0; opacity: 0; }

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
