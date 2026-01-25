<template>
  <el-dialog
    v-model="visible"
    :title="currentMap?.title || '思维导图'"
    fullscreen
    custom-class="mindmap-dialog"
    :before-close="handleClose"
    @opened="initMindMap"
  >
    <div class="mindmap-container" ref="mindmapRef"></div>
    
    <template #footer>
      <div class="dialog-footer">
        <el-button @click="handleClose">关闭</el-button>
        <el-button type="primary" @click="saveMap">保存更改</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'
import MindElixir, { E } from 'mind-elixir'
import { updateMindMap, type MindMap } from '../api/mindmap'
import { ElMessage } from 'element-plus'

// Import MindElixir styles - Critical for correct layout!
// Try to import from node_modules if possible, otherwise we might need to rely on global style or copy it
// Standard import for MindElixir 2.x/3.x
import 'mind-elixir/style.css'

const props = defineProps<{
  modelValue: boolean
  mindMapData: MindMap | null
}>()

const emit = defineEmits(['update:modelValue', 'saved'])

const visible = ref(false)
const mindmapRef = ref<HTMLElement | null>(null)
const currentMap = ref<MindMap | null>(null)
let me: any = null

watch(() => props.modelValue, (val) => {
  visible.value = val
  if (val && props.mindMapData) {
    currentMap.value = props.mindMapData
    // initMindMap is now called by @opened event on dialog
  }
})

watch(() => visible.value, (val) => {
  emit('update:modelValue', val)
})

const initMindMap = () => {
  if (!mindmapRef.value || !currentMap.value) return
  
  try {
    console.log('Mind Map Data:', currentMap.value.data)
    
    // 1. Get raw data
    let rawData = currentMap.value.data
    let data

    // 2. Parse data: handle string, object, or null/undefined
    if (typeof rawData === 'string') {
        try {
            // Prevent parsing "undefined" string
            if (rawData === 'undefined' || !rawData) {
                data = null
            } else {
                data = JSON.parse(rawData)
            }
        } catch (e) {
            console.warn('JSON parse error, using default', e)
            data = null
        }
    } else {
        // Already object or undefined/null
        data = rawData
    }
    
    // 3. Transformation logic
    const transformNode = (node: any): any => {
        return {
            topic: node.data?.text || node.topic || 'Node',
            id: Math.random().toString(36).substr(2, 9),
            children: node.children ? node.children.map(transformNode) : []
        }
    }
    
    let processedData
    
    // 4. Build MindElixir structure
    if (data && data.root) {
        // Adapt LLM format
        processedData = {
            nodeData: transformNode(data.root),
            linkData: {}
        }
    } else if (data && data.nodeData) {
        // Standard MindElixir format
        processedData = data
    } else {
        // 5. Fallback default (Critical: prevents undefined passing to MindElixir)
        console.warn('Invalid or empty data, using default template')
        processedData = {
            nodeData: { topic: '新思维导图', id: 'root', children: [] },
            linkData: {}
        }
    }

    // 6. Deep clone to remove Vue Proxy and ensure plain object
    // This prevents "undefined is not valid JSON" errors in MindElixir internal cloning
    const finalData = JSON.parse(JSON.stringify(processedData))
    console.log('Final MindElixir Data:', finalData)

    me = new MindElixir({
      el: mindmapRef.value,
      direction: MindElixir.RIGHT, // Changed to RIGHT for standard layout
      draggable: true,
      contextMenu: true,
      toolBar: true,
      nodeMenu: true,
      keypress: true,
      locale: 'zh_CN',
    })
    
    me.init(finalData)
  } catch (e) {
    console.error('Failed to init mind map', e)
    ElMessage.error('Failed to load mind map data')
  }
}

const saveMap = async () => {
  if (!currentMap.value || !me) return
  
  try {
    const data = me.getData()
    // We save the MindElixir format directly now to preserve layout/changes
    // But we need to wrap it or just stringify it.
    // Wait, our backend expects the "data" field to be the JSON string.
    // We can just save the raw MindElixir data structure.
    // But next time we load, we should check if it's already in MindElixir format.
    
    const dataStr = JSON.stringify(data)
    await updateMindMap(currentMap.value.id, dataStr)
    ElMessage.success('思维导图保存成功')
    emit('saved')
  } catch (e) {
    console.error(e)
    ElMessage.error('保存思维导图失败')
  }
}

const handleClose = () => {
  visible.value = false
}
</script>

<style scoped>
.mindmap-container {
  width: 100%;
  flex: 1;
  background: #f5f5f5;
  border-radius: 0;
}
:deep(.mindmap-dialog) {
    background: #1c1c1f;
    display: flex;
    flex-direction: column;
}
:deep(.el-dialog__body) {
    padding: 0;
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}
</style>
