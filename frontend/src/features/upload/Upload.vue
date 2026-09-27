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
import { useToast } from '../../composables/useToast'
import { checkUpload, uploadChunk, mergeChunks } from '../../api/upload'
import {
  listDocuments,
  activateDocument,
  deleteDocument,
  type DocumentSummary,
} from '../../api/documents'

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
/** 当前 MD5 Worker 实例，abort 时需要 terminate */
let md5Worker: Worker | null = null

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

/**
 * 在 Web Worker 中计算文件 MD5，避免阻塞主线程。
 * 进度（0-100%）通过 onProgress 回调返回，映射到整体进度条 0~20% 区间。
 */
function calcMD5Worker(
  file: File,
  onProgress: (p: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Vite 专用语法：将 worker 文件内联为模块
    const worker = new Worker(
      new URL('../../workers/md5.worker.ts', import.meta.url),
      { type: 'module' },
    )
    md5Worker = worker

    worker.onmessage = (e: MessageEvent) => {
      const { type, percent, md5, message } = e.data
      if (type === 'progress') {
        onProgress(percent)
      } else if (type === 'done') {
        worker.terminate()
        md5Worker = null
        resolve(md5)
      } else if (type === 'error') {
        worker.terminate()
        md5Worker = null
        reject(new Error(message))
      }
    }

    worker.onerror = (err) => {
      worker.terminate()
      md5Worker = null
      reject(err)
    }

    worker.postMessage({ file, chunkSize: CHUNK_SIZE })
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
    const md5 = await calcMD5Worker(file, (p) => {
      // Worker 进度 0~100% 映射到整体进度条 0~20%
      totalProgress.value = Math.round(p * 0.2)
      statusText.value = `计算文件指纹… ${Math.round(p * 0.2)}%`
    })

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
      toast.error('上传失败：' + (e?.response?.data?.message ?? e?.message ?? '未知错误'))
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
  // 终止还在计算的 MD5 Worker
  if (md5Worker) {
    md5Worker.terminate()
    md5Worker = null
  }
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

<style lang="scss" src="./Upload.scss" scoped></style>