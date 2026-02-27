<template>
  <div v-if="visible" class="mindmap-overlay">
    <div class="mindmap-header">
      <div class="left-section">
        <div class="title">{{ currentMap?.title || "思维导图" }}</div>
        <div class="toolbar">
          <el-tooltip content="撤销 (Ctrl+Z)" placement="bottom">
            <el-button circle @click="execUndo">
              <el-icon><RefreshLeft /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="前进 (Ctrl+Y)" placement="bottom">
            <el-button circle @click="execRedo">
              <el-icon><RefreshRight /></el-icon>
            </el-button>
          </el-tooltip>
          <div class="divider"></div>
          <el-tooltip content="适应画布" placement="bottom">
            <el-button circle @click="fitView">
              <el-icon><FullScreen /></el-icon>
            </el-button>
          </el-tooltip>
          <div class="divider"></div>
          <el-select
            v-model="currentLayout"
            placeholder="切换结构"
            style="width: 140px"
            @change="handleLayoutChange"
          >
            <el-option label="逻辑结构图" value="logicalStructure" />
            <el-option label="思维导图" value="mindMap" />
            <el-option label="组织结构图" value="organizationStructure" />
            <el-option label="时间轴" value="timeline" />
          </el-select>
        </div>
      </div>
      <div class="actions">
        <el-dropdown @command="handleExport" trigger="click">
          <el-button class="btn-export">
            <el-icon class="el-icon--left"><Download /></el-icon>
            导出
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="png">导出为 PNG 图片</el-dropdown-item>
              <el-dropdown-item command="svg">导出为 SVG 矢量图</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button class="btn-close" @click="handleClose">关闭</el-button>
        <el-button type="primary" class="btn-save" @click="saveMap"
          >保存更改</el-button
        >
      </div>
    </div>
    <div class="mindmap-container" ref="mindmapRef"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from "vue";
import MindMap from "simple-mind-map";
// @ts-ignore
import ExportPlugin from "simple-mind-map/src/plugins/Export.js";
import "simple-mind-map/dist/simpleMindMap.esm.css";
import { updateMindMap, type MindMap as MindMapType } from "../api/mindmap";
import { useToast } from "../composables/useToast";
import { RefreshLeft, RefreshRight, FullScreen, Download } from "@element-plus/icons-vue";

MindMap.usePlugin(ExportPlugin);

const props = defineProps<{
  modelValue: boolean;
  mindMapData: MindMapType | null;
}>();

const emit = defineEmits(["update:modelValue", "saved"]);
const toast = useToast();

const visible = ref(false);
const mindmapRef = ref<HTMLElement | null>(null);
const currentMap = ref<MindMapType | null>(null);
const currentLayout = ref("logicalStructure");
let mindMap: any = null;

watch(
  () => props.modelValue,
  (val) => {
    visible.value = val;
    if (val && props.mindMapData) {
      currentMap.value = props.mindMapData;
      initMindMap();
    }
  },
);

watch(
  () => visible.value,
  (val) => {
    emit("update:modelValue", val);
    if (!val && mindMap) {
      mindMap.destroy();
      mindMap = null;
    }
  },
);

// Theme Configuration - AI Purple & Neutral
const customTheme = {
  backgroundColor: "#FAF5FF", // Soft purple-tinted neutral
  lineColor: "#CBD5E1",
  lineWidth: 2,
  fontSize: 14,
  color: "#1E1B4B", // Deep navy text
  fillColor: "#FFFFFF",
  borderColor: "#E2E8F0",
  borderWidth: 1,
  borderRadius: 8,
  activeStrokeColor: "#7C3AED", // AI Purple
  root: {
    fillColor: "#7C3AED",
    color: "#FFFFFF",
    fontSize: 20,
    borderRadius: 10,
    activeStrokeColor: "#6D28D9",
  },
  second: {
    fillColor: "#F3E8FF",
    color: "#4338CA",
    borderColor: "#C4B5FD",
    activeStrokeColor: "#7C3AED",
  },
  node: {
    paddingX: 16,
    paddingY: 8,
  },
};

const initMindMap = () => {
  nextTick(() => {
    if (!mindmapRef.value || !currentMap.value) return;

    mindmapRef.value.innerHTML = "";

    try {
      let rawData = currentMap.value.data;
      let data: any;

      if (typeof rawData === "string") {
        try {
          if (rawData === "undefined" || !rawData) {
            data = null;
          } else {
            data = JSON.parse(rawData);
          }
        } catch (e) {
          data = null;
        }
      } else {
        data = rawData;
      }

      let processedData;
      const transformNode = (node: any): any => {
        return {
          data: {
            text: node.data?.text || node.topic || node.text || "节点",
            ...node.data,
          },
          children: node.children ? node.children.map(transformNode) : [],
        };
      };

      if (data && data.root) {
        processedData = transformNode(data.root);
      } else if (data && data.nodeData) {
        processedData = transformNode(data.nodeData);
      } else if (data && data.data && data.data.text) {
        processedData = data;
      } else {
        processedData = {
          data: { text: currentMap.value.title || "新思维导图" },
          children: [],
        };
      }

      mindMap = new MindMap({
        el: mindmapRef.value,
        data: processedData,
        theme: "default",
        themeConfig: customTheme,
        layout: currentLayout.value,
        readonly: false,
        // @ts-ignore
        supportNodeDrag: true,
        dragMinimizeDiff: 5,
      });

      setTimeout(() => {
        mindMap?.view.fit();
      }, 300);
    } catch (e) {
      console.error("Failed to init mind map", e);
      toast.error("加载思维导图失败");
    }
  });
};

const execUndo = () => {
  if (mindMap) {
    mindMap.execCommand("BACK");
  }
};

const execRedo = () => {
  if (mindMap) {
    mindMap.execCommand("FORWARD");
  }
};

const fitView = () => {
  mindMap?.view.fit();
};

const handleLayoutChange = (layout: string) => {
  if (mindMap) {
    mindMap.setLayout(layout);
    setTimeout(() => {
      mindMap?.view.fit();
    }, 100);
  }
};

const saveMap = async () => {
  if (!currentMap.value || !mindMap) return;

  try {
    const data = mindMap.getData();
    const dataStr = JSON.stringify(data);
    await updateMindMap(currentMap.value.id, dataStr);
    toast.success("思维导图保存成功");
    emit("saved");
  } catch (e) {
    toast.error("保存思维导图失败");
  }
};

const handleClose = () => {
  visible.value = false;
};

const handleExport = async (type: 'png' | 'svg') => {
  if (!mindMap) return;
  try {
    const title = currentMap.value?.title || '思维导图';
    if (type === 'png') {
      const data: string = await mindMap.export('png', true, title);
      downloadDataUrl(data, `${title}.png`);
    } else {
      const data: string = await mindMap.export('svg', true, title);
      downloadDataUrl(data, `${title}.svg`);
    }
    toast.success(`已导出为 ${type.toUpperCase()}`);
  } catch (e) {
    console.error(e);
    toast.error('导出失败');
  }
};

function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

onBeforeUnmount(() => {
  if (mindMap) {
    mindMap.destroy();
  }
});
</script>

<style scoped>
@import url("https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap");

.mindmap-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: #faf5ff;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  font-family: "Plus Jakarta Sans", sans-serif;
}

.mindmap-header {
  height: 72px;
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(124, 58, 237, 0.1);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32px;
  flex-shrink: 0;
  z-index: 10;
}

.left-section {
  display: flex;
  align-items: center;
  gap: 40px;
}

.title {
  font-size: 20px;
  font-weight: 700;
  color: #1e1b4b;
  letter-spacing: -0.02em;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #ffffff;
  padding: 6px;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
}

.divider {
  width: 1px;
  height: 20px;
  background: #e2e8f0;
  margin: 0 4px;
}

.actions {
  display: flex;
  gap: 12px;
}

.btn-export {
  padding: 0 24px;
  height: 40px;
  border-radius: 10px;
}

.btn-save {
  background: #7c3aed;
  border-color: #7c3aed;
  font-weight: 600;
  padding: 0 24px;
  height: 40px;
  border-radius: 10px;
  transition: all 0.2s;
}
.btn-close {
  padding: 0 24px;
  height: 40px;
  border-radius: 10px;
}

.btn-save:hover {
  background: #6d28d9;
  border-color: #6d28d9;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
}

.mindmap-container {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #faf5ff;
}

/* Custom styles for select and buttons */
:deep(.el-button.is-circle) {
  border: none;
  color: #64748b;
  font-size: 18px;
  transition: all 0.2s;
}

:deep(.el-button.is-circle:hover) {
  background: #f5f3ff;
  color: #7c3aed;
}

:deep(.el-select .el-input__wrapper) {
  border-radius: 8px;
  box-shadow: none !important;
  border: 1px solid transparent;
  background: #f8fafc;
  transition: all 0.2s;
}

:deep(.el-select .el-input__wrapper:hover) {
  background: #f1f5f9;
}

:deep(.el-select .el-input.is-focus .el-input__wrapper) {
  border-color: #7c3aed;
  background: #ffffff;
}
</style>
