<template>
  <div class="upload-container">
    <div v-if="!isUploaded">
      <el-upload
        class="upload-demo"
        drag
        action="/api/upload"
        :headers="uploadHeaders"
        :on-success="handleSuccess"
        :on-error="handleError"
        :before-upload="beforeUpload"
        :show-file-list="false"
      >
        <el-icon class="el-icon--upload"><upload-filled /></el-icon>
        <div class="el-upload__text">
          将文件拖到此处，或 <em>点击上传</em>
        </div>
        <template #tip>
          <div class="el-upload__tip">
            支持 PDF/Markdown 文件，大小不超过 10MB
          </div>
        </template>
      </el-upload>
    </div>

    <div v-else class="uploaded-state">
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
import { UploadFilled, CircleCheckFilled, Close, Connection } from '@element-plus/icons-vue'
import type { UploadProps } from 'element-plus'
import MindMapEditor from './MindMapEditor.vue'
import { generateMindMap, type MindMap } from '../api/mindmap'
import { useToast } from '../composables/useToast'

const isUploaded = ref(false)
const uploadedFileName = ref('')
const generating = ref(false)
const editorVisible = ref(false)
const currentMindMap = ref<MindMap | null>(null)

const emit = defineEmits(['generated'])
const toast = useToast()

const uploadHeaders = computed(() => ({
  Authorization: `Bearer ${localStorage.getItem('token')}`
}))

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

const handleSaved = () => {
}


const handleSuccess: UploadProps['onSuccess'] = (response, uploadFile) => {
  toast.success('文件处理成功！')
  isUploaded.value = true
  uploadedFileName.value = uploadFile.name
}

const handleError: UploadProps['onError'] = (error) => {
  toast.error('上传失败，请重试。')
  console.error(error)
}

const beforeUpload: UploadProps['beforeUpload'] = (rawFile) => {
  const isValidType = rawFile.type === 'application/pdf' || rawFile.name.endsWith('.md')
  const isLt10M = rawFile.size / 1024 / 1024 < 10

  if (!isValidType) {
    toast.error('文件必须是 PDF 或 Markdown 格式！')
    return false
  }
  if (!isLt10M) {
    toast.error('文件大小不能超过 10MB！')
    return false
  }
  return true
}

const resetUpload = () => {
  isUploaded.value = false
  uploadedFileName.value = ''
}
</script>

<style scoped lang="scss">
.upload-container {
  padding: 0 10px;
  
  :deep(.el-upload) {
    width: 100%;
  }

  :deep(.el-upload-dragger) {
    background: rgba(255,255,255,0.02);
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
</style>
