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
          <div class="el-upload__tip">
            支持 PDF/Markdown 文件，支持断点续传
          </div>
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
        <el-button
          v-if="!isPaused"
          size="small"
          @click="pauseUpload"
        >
          <el-icon><VideoPause /></el-icon> 暂停
        </el-button>
        <el-button
          v-else
          type="primary"
          size="small"
          @click="resumeUpload"
        >
          <el-icon><VideoPlay /></el-icon> 继续
        </el-button>
        <el-button size="small" type="danger" @click="cancelUpload">
          取消
        </el-button>
      </div>
    </div>

    <!-- 已上传状态 -->
    <div v-if="isUploaded" class="uploaded-state">
      <div class="file-info">
        <el-icon class="success-icon"><CircleCheckFilled /></el-icon>
        <span class="filename">{{ uploadedFileName }}</span>
      </div>
      <div class="actions">
        <el-button type="primary" size="small" @click="handleGenerateMindMap" :loading="generating">
          <el-icon class="el-icon--left"><Connection /></el-icon>
          生成思维导图
        </el-button>
        <el-button type="danger" circle size="small" @click="resetUpload">
          <el-icon><Close /></el-icon>
        </el-button>
      </div>
    </div>
  </div>

  <MindMapEditor
    v-model="editorVisible"
    :mind-map-data="currentMindMap"
    @saved="handleSaved"
  />
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  UploadFilled,
  CircleCheckFilled,
  Close,
  Connection,
  Loading,
  VideoPause,
  VideoPlay,
} from '@element-plus/icons-vue'
import type { UploadFile } from 'element-plus'
import SparkMD5 from 'spark-md5'
import MindMapEditor from './MindMapEditor.vue'
import { generateMindMap, type MindMap } from '../api/mindmap'
import { useToast } from '../composables/useToast'
import { checkUpload, uploadChunk, mergeChunks } from '../api/upload'

// ——— 常量 ———
const CHUNK_SIZE = 5 * 1024 * 1024 // 5MB
const CONCURRENCY = 3 // 并发上传分片数

// ——— 状态 ———
const isUploaded = ref(false)
const isUploading = ref(false)
const uploadedFileName = ref('')
const generating = ref(false)
const editorVisible = ref(false)
const currentMindMap = ref<MindMap | null>(null)
const pendingFile = ref<File | null>(null)
const isPaused = ref(false)
const totalProgress = ref(0)
const statusText = ref('')

// 用于暂停控制
let abortFlag = false
let uploadedChunkSet = new Set<number>()

const emit = defineEmits(['generated'])
const toast = useToast()

const progressStatus = computed(() => {
  if (totalProgress.value === 100) return 'success'
  if (isPaused.value) return 'warning'
  return ''
})

// ——— 文件选择 ———
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

// ——— MD5 计算（分批 FileReader，避免主线程阻塞）———
function calcMD5(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const spark = new SparkMD5.ArrayBuffer()
    const reader = new FileReader()
    const chunkCount = Math.ceil(file.size / CHUNK_SIZE)
    let currentChunk = 0

    const loadNext = () => {
      const start = currentChunk * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, file.size)
      reader.readAsArrayBuffer(file.slice(start, end))
    }

    reader.onload = (e) => {
      spark.append(e.target!.result as ArrayBuffer)
      currentChunk++
      if (currentChunk < chunkCount) {
        // 更新 MD5 计算进度（显示为 0~20% 进度范围）
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

// ——— 主上传流程 ———
async function startChunkUpload(file: File) {
  isUploading.value = true
  abortFlag = false
  isPaused.value = false
  totalProgress.value = 0
  uploadedChunkSet = new Set()

  try {
    // 1. 计算 MD5
    statusText.value = '计算文件指纹…'
    const md5 = await calcMD5(file)

    // 2. 秒传检测 + 查询已上传分片
    statusText.value = '检查文件状态…'
    const { uploaded, uploadedChunks = [] } = await checkUpload(md5, file.name)

    if (uploaded) {
      toast.success('⚡ 秒传成功！')
      finishUpload(file.name)
      return
    }

    uploadedChunkSet = new Set(uploadedChunks)
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

    // 3. 分片上传（并发）
    const pendingIndexes = Array.from({ length: totalChunks }, (_, i) => i).filter(
      (i) => !uploadedChunkSet.has(i),
    )

    let doneChunks = uploadedChunks.length

    const uploadSingle = async (index: number) => {
      if (abortFlag) return

      // 等待暂停恢复
      while (isPaused.value && !abortFlag) {
        await sleep(300)
      }
      if (abortFlag) return

      const start = index * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, file.size)
      const blob = file.slice(start, end)

      await uploadChunk(blob, md5, index, totalChunks, file.name)
      uploadedChunkSet.add(index)
      doneChunks++

      // 进度 20% ~ 95%
      totalProgress.value = 20 + Math.round((doneChunks / totalChunks) * 75)
      statusText.value = `上传中… ${doneChunks}/${totalChunks} 片`
    }

    // 限速并发
    await asyncPool(CONCURRENCY, pendingIndexes, uploadSingle)

    if (abortFlag) return

    // 4. 合并
    statusText.value = '服务器合并处理中…'
    totalProgress.value = 96
    await mergeChunks(md5, file.name, totalChunks)

    totalProgress.value = 100
    toast.success('文件处理成功！')
    await sleep(600)
    finishUpload(file.name)
  } catch (e: any) {
    if (!abortFlag) {
      console.error(e)
      toast.error('上传失败：' + (e?.response?.data?.error ?? e?.message ?? '未知错误'))
      cancelUpload()
    }
  }
}

// ——— 控制方法 ———
const pauseUpload = () => {
  isPaused.value = true
  statusText.value = '已暂停'
}

const resumeUpload = () => {
  isPaused.value = false
  statusText.value = '恢复上传…'
}

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

// ——— Mind Map ———
const handleGenerateMindMap = async () => {
  generating.value = true
  try {
    const map = await generateMindMap()
    currentMindMap.value = map
    editorVisible.value = true
    toast.success('思维导图生成成功！')
    emit('generated')
  } catch (e) {
    console.error(e)
    toast.error('生成思维导图失败')
  } finally {
    generating.value = false
  }
}

const handleSaved = () => {}

// ——— 工具函数 ———
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 限并发异步池 */
async function asyncPool<T>(
  concurrency: number,
  items: T[],
  fn: (item: T) => Promise<void>,
) {
  const executing: Promise<void>[] = []
  for (const item of items) {
    const p = fn(item).then(() => {
      executing.splice(executing.indexOf(p), 1)
    })
    executing.push(p)
    if (executing.length >= concurrency) {
      await Promise.race(executing)
    }
  }
  await Promise.all(executing)
}
</script>

<style scoped lang="scss">
.upload-container {
  padding: 0 10px;

  :deep(.el-upload) {
    width: 100%;
  }

  :deep(.el-upload-dragger) {
    background: rgba(255, 255, 255, 0.02);
    border: 1px dashed var(--border-color);
    padding: 32px 16px;
    height: auto;
    border-radius: 12px;
    transition: all 0.2s;

    &:hover {
      border-color: var(--accent-color);
      background-color: var(--bg-hover);
    }

    &.is-dragover {
      background-color: rgba(139, 92, 246, 0.1);
      border-color: var(--accent-color);
    }
  }

  :deep(.el-icon--upload) {
    font-size: 48px;
    color: var(--text-secondary);
    margin-bottom: 16px;
    transition: color 0.2s;
  }

  :deep(.el-upload-dragger:hover .el-icon--upload) {
    color: var(--accent-color);
  }

  :deep(.el-upload__text) {
    color: var(--text-primary);
    font-size: 0.875rem;
    line-height: 1.5;

    em {
      color: var(--accent-color);
      font-style: normal;
      font-weight: 600;
    }
  }

  :deep(.el-upload__tip) {
    color: var(--text-secondary);
    font-size: 0.75rem;
    margin-top: 12px;
    text-align: center;
  }

  // ——— 上传中状态 ———
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

        &.is-paused {
          animation: none;
          color: #f59e0b;
        }
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

      .progress-label {
        font-size: 0.75rem;
        color: var(--text-secondary);
        text-align: right;
      }
    }

    .upload-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
  }

  // ——— 已上传状态 ———
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

      .success-icon {
        color: #10b981;
        font-size: 20px;
        flex-shrink: 0;
      }

      .filename {
        color: var(--text-primary);
        font-size: 0.875rem;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    :deep(.el-button--danger) {
      background: transparent;
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: #ef4444;

      &:hover {
        background: #ef4444;
        color: white;
        border-color: #ef4444;
      }
    }
  }
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
