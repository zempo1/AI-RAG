<template>
  <aside class="workbench" :class="{ collapsed: isCollapsed }">
    <!-- 折叠状态：竖排图标条 -->
    <div v-if="isCollapsed" class="collapsed-strip" @click="isCollapsed = false">
      <el-tooltip content="展开工作台" placement="left">
        <div class="expand-btn">
          <el-icon><ArrowLeft /></el-icon>
        </div>
      </el-tooltip>
      <span class="vertical-label">工作台</span>
    </div>

    <!-- 展开状态 -->
    <template v-else>
      <!-- 顶部标题栏 -->
      <div class="wb-header">
        <div class="wb-title">
          <el-icon class="wb-title-icon"><Grid /></el-icon>
          <span>工作台</span>
        </div>
        <el-tooltip content="收起工作台" placement="left">
          <div class="collapse-btn" @click="isCollapsed = true">
            <el-icon><ArrowRight /></el-icon>
          </div>
        </el-tooltip>
      </div>

      <!-- 生成思维导图区域 -->
      <div class="wb-section generate-section">
        <div class="section-label">思维导图</div>

        <!-- 当前激活文件 -->
        <div class="active-file" v-if="uploadedFileName">
          <el-icon class="file-icon"><Document /></el-icon>
          <span class="file-name" :title="uploadedFileName">{{ uploadedFileName }}</span>
        </div>
        <div class="no-file" v-else>
          <el-icon><InfoFilled /></el-icon>
          <span>请先在左侧上传或激活文件</span>
        </div>

        <el-button
          class="generate-btn"
          type="primary"
          :disabled="!uploadedFileName || !props.uploadedDocumentId"
          :loading="generating"
          @click="handleGenerate"
        >
          <el-icon class="el-icon--left"><Connection /></el-icon>
          生成思维导图
        </el-button>
      </div>

      <!-- 分割线 -->
      <div class="wb-divider" />

      <!-- 思维导图历史 -->
      <div class="wb-section history-section">
        <div class="section-label">历史记录</div>
        <div class="mind-map-list">
          <div v-if="loading" class="list-empty">加载中…</div>
          <div v-else-if="mindMaps.length === 0" class="list-empty">暂无思维导图</div>
          <div
            v-for="map in mindMaps"
            :key="map.id"
            class="map-item"
            @click="handleOpen(map)"
          >
            <div class="map-item-content">
              <el-icon class="map-icon"><Connection /></el-icon>
              <div class="map-info">
                <el-tooltip :content="map.title" placement="right" :show-after="400" :hide-after="0">
                  <span class="map-title">{{ map.title }}</span>
                </el-tooltip>
                <span class="map-time">{{ formatTime(map.createdAt) }}</span>
              </div>
            </div>
            <div class="map-actions">
              <el-tooltip content="删除" placement="left">
                <el-icon class="delete-icon" @click.stop="handleDelete(map.id)">
                  <Delete />
                </el-icon>
              </el-tooltip>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- MindMapEditor 弹层（内部自治） -->
    <MindMapEditor
      v-model="editorVisible"
      :mind-map-data="currentMindMap"
      @saved="onSaved"
    />
  </aside>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  ArrowLeft,
  ArrowRight,
  Grid,
  Connection,
  Document,
  InfoFilled,
  Delete,
} from '@element-plus/icons-vue'
import MindMapEditor from './MindMapEditor.vue'
import {
  generateMindMap,
  getMindMaps,
  deleteMindMap as apiDeleteMindMap,
  type MindMap,
} from '../api/mindmap'
import { useToast } from '../composables/useToast'
import { useConfirm } from '../composables/useConfirm'

const props = defineProps<{
  uploadedFileName: string
  uploadedDocumentId: number | null
}>() 

const toast = useToast()
const confirm = useConfirm()

const isCollapsed = ref(false)
const generating = ref(false)
const loading = ref(false)
const mindMaps = ref<MindMap[]>([])
const editorVisible = ref(false)
const currentMindMap = ref<MindMap | null>(null)

// ——— 加载历史 ———
const loadMindMaps = async () => {
  loading.value = true
  try {
    mindMaps.value = await getMindMaps()
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => loadMindMaps())

// ——— 生成思维导图 ———
const handleGenerate = async () => {
  if (!props.uploadedDocumentId) {
    toast.error('请先选择文件')
    return
  }
  generating.value = true
  try {
    const map = await generateMindMap(props.uploadedDocumentId)
    currentMindMap.value = map
    editorVisible.value = true
    toast.success('思维导图生成成功！')
    await loadMindMaps()
  } catch (e) {
    console.error(e)
    toast.error('生成思维导图失败')
  } finally {
    generating.value = false
  }
}

// ——— 打开历史 ———
const handleOpen = (map: MindMap) => {
  currentMindMap.value = map
  editorVisible.value = true
}

// ——— 删除 ———
const handleDelete = async (id: number) => {
  const ok = await confirm.danger('确定要删除这个思维导图吗？删除后无法恢复。', '删除确认')
  if (!ok) return
  try {
    await apiDeleteMindMap(id)
    mindMaps.value = mindMaps.value.filter((m) => m.id !== id)
    toast.success('思维导图已删除')
  } catch (e) {
    console.error(e)
    toast.error('删除失败')
  }
}

// ——— 保存回调 ———
const onSaved = () => {
  loadMindMaps()
}

// ——— 时间格式化 ———
function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diffDays === 0) return '今天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays} 天前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

// 暴露刷新方法（供 App.vue 调用）
defineExpose({ loadMindMaps })
</script>

<style lang="scss" scoped>
.workbench {
  width: 290px;
  background-color: var(--bg-sidebar);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  transition: width 0.3s ease;
  overflow: hidden;
  flex-shrink: 0;

  &.collapsed {
    width: 40px;
  }
}

// ——— 折叠条 ———
.collapsed-strip {
  width: 40px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 16px;
  gap: 12px;
  cursor: pointer;

  .expand-btn {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    transition: all 0.2s;

    &:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .el-icon { font-size: 14px; }
  }

  .vertical-label {
    writing-mode: vertical-rl;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 0.1em;
    user-select: none;
  }
}

// ——— 顶部标题 ———
.wb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 12px;
  flex-shrink: 0;

  .wb-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-primary);

    .wb-title-icon {
      font-size: 16px;
      color: var(--accent-color);
    }
  }

  .collapse-btn {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.2s;

    &:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .el-icon { font-size: 13px; }
  }
}

// ——— 通用 section ———
.wb-section {
  padding: 0 14px 16px;
  flex-shrink: 0;

  .section-label {
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 10px;
  }
}

.wb-divider {
  height: 1px;
  background: var(--border-color);
  margin: 0 14px 16px;
  flex-shrink: 0;
}

// ——— 生成区域 ———
.generate-section {
  .active-file {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(139, 92, 246, 0.08);
    border: 1px solid rgba(139, 92, 246, 0.2);
    border-radius: 8px;
    padding: 8px 10px;
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
    padding: 2px 0;

    .el-icon { font-size: 13px; }
  }

  .generate-btn {
    width: 100%;
    background: var(--primary-gradient);
    border: none;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 500;
    transition: opacity 0.2s, transform 0.1s;

    &:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
    &:active:not(:disabled) { transform: translateY(0); }
    &:disabled { opacity: 0.4; cursor: not-allowed; }
  }
}

// ——— 历史列表 ———
.history-section {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  .mind-map-list {
    flex: 1;
    overflow-y: auto;

    .list-empty {
      font-size: 0.8rem;
      color: var(--text-secondary);
      text-align: center;
      padding: 20px 0;
    }

    .map-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 9px 10px;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s;
      margin-bottom: 2px;

      &:hover {
        background: var(--bg-hover);

        .map-actions { opacity: 1; }
      }

      .map-item-content {
        display: flex;
        align-items: center;
        gap: 10px;
        overflow: hidden;
        flex: 1;

        .map-icon {
          font-size: 15px;
          color: var(--accent-color);
          flex-shrink: 0;
        }

        .map-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
          overflow: hidden;

          .map-title {
            font-size: 0.83rem;
            color: var(--text-primary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .map-time {
            font-size: 0.7rem;
            color: var(--text-secondary);
          }
        }
      }

      .map-actions {
        opacity: 0;
        transition: opacity 0.15s;
        flex-shrink: 0;
        margin-left: 6px;

        .delete-icon {
          font-size: 14px;
          color: var(--text-secondary);
          padding: 4px;
          border-radius: 4px;
          transition: all 0.15s;

          &:hover {
            background: rgba(239, 68, 68, 0.15);
            color: #ef4444;
          }
        }
      }
    }
  }
}
</style>
