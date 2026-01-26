<template>
  <div v-if="visible" class="mindmap-overlay">
    <div class="mindmap-header">
      <div class="title">{{ currentMap?.title || '思维导图' }}</div>
      <div class="actions">
        <el-button @click="handleClose">关闭</el-button>
        <el-button type="primary" @click="saveMap">保存更改</el-button>
      </div>
    </div>
    <div class="mindmap-container" ref="mindmapRef"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick, onMounted } from 'vue'
import MindMap from 'simple-mind-map'
import 'simple-mind-map/dist/simpleMindMap.esm.css'
import { updateMindMap, type MindMap as MindMapType } from '../api/mindmap'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  modelValue: boolean
  mindMapData: MindMapType | null
}>()

const emit = defineEmits(['update:modelValue', 'saved'])

const visible = ref(false)
const mindmapRef = ref<HTMLElement | null>(null)
const currentMap = ref<MindMapType | null>(null)
let mindMap: MindMap | null = null

watch(() => props.modelValue, (val) => {
  visible.value = val
  if (val && props.mindMapData) {
    currentMap.value = props.mindMapData
    if (val) {
      // Initialize when opened
      initMindMap()
    }
  }
})

watch(() => visible.value, (val) => {
  emit('update:modelValue', val)
  if (!val && mindMap) {
    mindMap.destroy()
    mindMap = null
  }
})

// Theme Configuration
const customTheme = {
  backgroundColor: '#f5f7fa',
  lineColor: '#cbd5e1',
  lineWidth: 2,
  fontSize: 14,
  color: '#334155',
  fillColor: '#ffffff',
  borderColor: '#e2e8f0',
  borderWidth: 1,
  borderRadius: 6,
  activeStrokeColor: '#8b5cf6',
  root: {
    fillColor: '#8b5cf6',
    color: '#ffffff',
    fontSize: 20,
    borderRadius: 8,
    activeStrokeColor: '#7c3aed',
  },
  second: {
    fillColor: '#f1f5f9',
    color: '#1e293b',
    borderColor: '#cbd5e1',
    activeStrokeColor: '#8b5cf6',
  }
}

const initMindMap = () => {
  // Wait for DOM render
  nextTick(() => {
    if (!mindmapRef.value || !currentMap.value) return
    
    // Clear container
    mindmapRef.value.innerHTML = ''

    try {
      // 1. Get raw data
      let rawData = currentMap.value.data
      let data: any

      // 2. Parse data
      if (typeof rawData === 'string') {
          try {
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
          data = rawData
      }

      // 3. Transform Data
      let processedData
      
      const transformNode = (node: any): any => {
          return {
              data: {
                  text: node.data?.text || node.topic || node.text || 'Node',
                  ...node.data
              },
              children: node.children ? node.children.map(transformNode) : []
          }
      }

      if (data && data.root) {
          processedData = transformNode(data.root)
      } else if (data && data.nodeData) {
          processedData = transformNode(data.nodeData)
      } else if (data && data.data && data.data.text) {
          processedData = data
      } else {
          processedData = {
              data: { text: '新思维导图' },
              children: []
          }
      }

      // 4. Initialize simple-mind-map
      mindMap = new MindMap({
        el: mindmapRef.value,
        data: processedData,
        theme: 'default',
        themeConfig: customTheme,
        layout: 'logicalStructure',
        readonly: false,
        supportNodeDrag: true,
        dragMinimizeDiff: 5
      })
      
      // Delay fit to ensure rendering is complete
      setTimeout(() => {
        mindMap?.view.fit()
      }, 200)

    } catch (e) {
      console.error('Failed to init mind map', e)
      ElMessage.error('加载思维导图失败')
    }
  })
}

const saveMap = async () => {
  if (!currentMap.value || !mindMap) return
  
  try {
    const data = mindMap.getData()
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

onBeforeUnmount(() => {
    if (mindMap) {
        mindMap.destroy()
    }
})
</script>

<style scoped>
.mindmap-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: #f5f7fa;
  z-index: 2000;
  display: flex;
  flex-direction: column;
}

.mindmap-header {
  height: 60px;
  background: #ffffff;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  flex-shrink: 0;
}

.title {
  font-size: 18px;
  font-weight: 600;
  color: #1e293b;
}

.mindmap-container {
  flex: 1;
  width: 100%;
  height: 100%; /* Ensure it fills remaining space */
  overflow: hidden;
}
</style>
