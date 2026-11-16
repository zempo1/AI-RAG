<template>
  <section
    class="mindmap-panel"
    :class="{ 'is-fullscreen': fullscreen }"
    role="region"
    aria-label="思维导图编辑器"
  >
    <header class="mindmap-heading">
      <div>
        <h2>{{ currentMap?.title || "思维导图" }}</h2>
        <span v-if="dirty" class="dirty-state">有未保存的更改</span>
      </div>
      <div class="heading-actions">
        <button @click="toggleFullscreen" :aria-label="fullscreen ? '退出全屏' : '全屏'">
          {{ fullscreen ? "退出全屏" : "全屏" }}</button
        ><button @click="close" aria-label="关闭思维导图">关闭</button>
      </div>
    </header>
    <p v-if="currentMap?.sourceOutdated" class="mindmap-notice">
      来源已更新，此导图基于历史版本，可返回工作台重新生成。
    </p>
    <p v-if="oversized" class="mindmap-notice">历史导图超出编辑规模限制，仍可查看和导出。</p>
    <p v-if="documentData?.meta?.assembly?.organization === 'source-order'" class="mindmap-notice">
      已按来源顺序组织知识点，可直接编辑分组。
    </p>
    <p
      v-if="
        documentData?.meta?.assembly?.omittedTopics || documentData?.meta?.assembly?.omittedPoints
      "
      class="mindmap-notice"
    >
      当前为均衡学习导图，受节点数量限制，部分细节未展示，请结合原文阅读。
    </p>
    <div class="mindmap-toolbar" v-if="!failure">
      <button @click="command('BACK')" :disabled="!canvas || oversized">撤销</button
      ><button @click="command('FORWARD')" :disabled="!canvas || oversized">重做</button>
      <button
        class="zoom-button"
        aria-label="缩小"
        @click="canvas?.view.narrow()"
        :disabled="!canvas"
      >
        −</button
      ><button
        class="zoom-button"
        aria-label="放大"
        @click="canvas?.view.enlarge()"
        :disabled="!canvas"
      >
        ＋</button
      ><button @click="fit" :disabled="!canvas">适应画布</button>
      <button @click="expand(true)" :disabled="!canvas">全部展开</button
      ><button @click="expand(false)" :disabled="!canvas">全部收起</button>
      <el-dropdown
        ref="layoutDropdown"
        @visible-change="layoutMenuOpen = $event"
        trigger="click"
        popper-class="mindmap-layout-menu"
        :show-arrow="false"
        @command="changeLayout"
        :disabled="!canvas || oversized"
      >
        <button class="layout-trigger" aria-label="导图布局" :disabled="!canvas || oversized">
          <span>{{ layoutOptions.find((item) => item.value === layout)?.label }}</span>
          <svg class="layout-chevron" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="m5 7.5 5 5 5-5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <template #dropdown
          ><el-dropdown-menu
            ><el-dropdown-item
              v-for="item in layoutOptions"
              :key="item.value"
              :command="item.value"
              :class="{ 'is-selected': layout === item.value }"
              ><span>{{ item.label }}</span
              ><span v-if="layout === item.value" aria-hidden="true">✓</span></el-dropdown-item
            ></el-dropdown-menu
          ></template
        >
      </el-dropdown>
      <button @click="exportMap" :disabled="!canvas">导出 PNG</button
      ><button class="primary" @click="save" :disabled="!canvas || saving || oversized">
        {{ saving ? "保存中…" : "保存更改" }}
      </button>
    </div>
    <p v-if="loading" role="status" class="mindmap-status">正在加载思维导图…</p>
    <div v-if="failure" role="alert" class="mindmap-status">
      <p>{{ failure }}</p>
      <button @click="load">重新加载</button>
    </div>
    <div ref="container" class="mindmap-canvas" :aria-busy="loading"></div>
    <div
      v-if="leaveResolver"
      class="mindmap-confirm"
      role="dialog"
      aria-modal="true"
      aria-label="保存思维导图更改"
    >
      <div class="mindmap-confirm-card" ref="confirmCard">
        <h3>保存更改后再离开？</h3>
        <p>思维导图有未保存的更改，离开前可以保存当前内容。</p>
        <div class="mindmap-confirm-actions">
          <button @click="resolveLeave(false)" :disabled="saving">取消</button>
          <button @click="resolveLeave(true)" :disabled="saving">放弃更改</button>
          <button class="primary" :disabled="saving" @click="saveBeforeLeave">
            {{ saving ? "保存中…" : "保存并继续" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { ref, shallowRef, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { getMindMap, updateMindMap, type MindMap } from "../../api/mindmap";
import { normalizeMindMap, isOversizedMindMap, type MindMapDocument } from "./mindmap-data";
import { useToast } from "../../composables/useToast";
import "simple-mind-map/dist/simpleMindMap.esm.css";
const props = defineProps<{ mapId: number }>();
const emit = defineEmits<{ (e: "close"): void; (e: "saved"): void }>();
const toast = useToast(),
  container = ref<HTMLElement>(),
  canvas = shallowRef<any>(null),
  currentMap = ref<MindMap>(),
  loading = ref(false),
  failure = ref(""),
  fullscreen = ref(false),
  dirty = ref(false),
  saving = ref(false),
  oversized = ref(false),
  layout = ref("logicalStructure");
const documentData = shallowRef<MindMapDocument>();
const layoutDropdown = shallowRef<any>();
const layoutMenuOpen = ref(false);
const layoutOptions = [
  { value: "logicalStructure", label: "逻辑结构图" },
  { value: "mindMap", label: "思维导图" },
  { value: "organizationStructure", label: "组织结构图" },
  { value: "timeline", label: "时间轴" },
];
let observer: ResizeObserver | undefined,
  sequence = 0,
  initialized = false;
let savedContent = "";
const leaveResolver = shallowRef<((value: boolean) => void) | null>(null);
const confirmCard = ref<HTMLElement>();
let previousFocus: HTMLElement | null = null;
// Fold state is a reading preference. Explicit saves still persist it with the tree.
const fingerprint = () =>
  JSON.stringify({ root: canvas.value?.getData(), layout: layout.value }, (key, value) =>
    key === "expand" ? undefined : value,
  );
const markChanged = () => {
  const editor = canvas.value?.renderer.textEdit;
  const draftChanged =
    editor?.isShowTextEdit() && editor.getEditText() !== editor.currentNode?.getData("text");
  if (initialized) dirty.value = fingerprint() !== savedContent || !!draftChanged;
};
function fit() {
  canvas.value?.view.fit();
}
function afterRender(action: () => void) {
  if (!canvas.value) return;
  const instance = canvas.value;
  const callback = () => {
    instance.off("node_tree_render_end", callback);
    action();
  };
  instance.on("node_tree_render_end", callback);
}
async function load() {
  const revision = ++sequence;
  loading.value = true;
  failure.value = "";
  initialized = false;
  canvas.value?.destroy();
  canvas.value = null;
  observer?.disconnect();
  try {
    const [map, library] = await Promise.all([getMindMap(props.mapId), import("simple-mind-map")]);
    if (revision !== sequence) return;
    currentMap.value = map;
    documentData.value = normalizeMindMap(map.data);
    layout.value = documentData.value.layout;
    oversized.value = isOversizedMindMap(documentData.value.root);
    await nextTick();
    if (revision !== sequence || !container.value) return;
    const instance = new (library.default as any)({
      el: container.value,
      data: documentData.value.root,
      layout: layout.value,
      readonly: oversized.value,
      theme: "default",
      themeConfig: {
        backgroundColor: "#111820",
        lineColor: "#547889",
        lineWidth: 1.5,
        lineStyle: "curve",
        root: {
          fillColor: "#174e63",
          color: "#ffffff",
          borderColor: "#34839a",
          borderWidth: 1,
          borderRadius: 12,
          fontSize: 19,
          paddingX: 22,
          paddingY: 14,
        },
        second: {
          fillColor: "#223543",
          color: "#f8fafc",
          borderColor: "#3c5969",
          borderWidth: 1,
          borderRadius: 8,
          fontSize: 16,
          paddingX: 16,
          paddingY: 10,
        },
        node: {
          marginY: 14,
          fillColor: "#18242e",
          color: "#f1f5f9",
          borderColor: "transparent",
          borderRadius: 6,
          fontSize: 15,
          paddingX: 12,
          paddingY: 7,
        },
        generalization: { color: "#f1f5f9", fillColor: "#223543" },
      },
    });
    canvas.value = instance;
    instance.on("node_tree_render_end", () => {
      if (!initialized) {
        fit();
        savedContent = fingerprint();
        dirty.value = false;
        initialized = true;
      }
    });
    instance.on("node_text_edit_change", () => {
      dirty.value = true;
    });
    instance.on("data_change", markChanged);
    instance.on("layout_change", markChanged);
    observer = new ResizeObserver(() => {
      instance.resize();
    });
    observer.observe(container.value);
  } catch (error) {
    if (revision === sequence)
      failure.value = error instanceof Error ? error.message : "思维导图加载失败";
  } finally {
    if (revision === sequence) loading.value = false;
  }
}
function command(name: string) {
  canvas.value?.execCommand(name);
}
function expand(all: boolean) {
  afterRender(() => {
    fit();
    markChanged();
  });
  command(all ? "EXPAND_ALL" : "UNEXPAND_ALL");
}
function changeLayout(value: string) {
  layout.value = value;
  afterRender(() => {
    fit();
    markChanged();
  });
  canvas.value?.setLayout(value);
}
async function toggleFullscreen() {
  fullscreen.value = !fullscreen.value;
  await nextTick();
  canvas.value?.resize();
  fit();
}
async function save() {
  if (!canvas.value || oversized.value || saving.value) return false;
  saving.value = true;
  try {
    canvas.value.renderer.textEdit.hideEditTextBox();
    const full = canvas.value.getData(true);
    const data = {
      ...documentData.value,
      ...full,
      schemaVersion: 2,
      meta: documentData.value?.meta,
    };
    const snapshot = fingerprint();
    await updateMindMap(props.mapId, JSON.stringify(data));
    savedContent = snapshot;
    dirty.value = fingerprint() !== snapshot;
    emit("saved");
    toast.success("思维导图保存成功");
    return true;
  } catch {
    toast.error("保存失败，当前更改已保留");
    return false;
  } finally {
    saving.value = false;
  }
}
async function exportMap() {
  const type = "png";
  const instance = canvas.value;
  const view = instance?.view.getTransformData();
  try {
    const { default: Export } = await import("simple-mind-map/src/plugins/Export.js");
    if (!canvas.value.doExport) canvas.value.addPlugin(Export);
    const url = await canvas.value.export(type, false, currentMap.value?.title || "思维导图");
    if (!url) throw new Error("导出失败");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentMap.value?.title || "思维导图"}.${type}`;
    a.click();
  } catch {
    toast.error("导出失败，请重试");
  } finally {
    if (canvas.value === instance && view) instance.view.setTransformData(view);
  }
}
function requestLeave(): Promise<boolean> {
  canvas.value?.renderer.textEdit.hideEditTextBox();
  markChanged();
  if (!dirty.value) return Promise.resolve(true);
  if (leaveResolver.value) return Promise.resolve(false);
  return new Promise((resolve) => (leaveResolver.value = resolve));
}
function resolveLeave(allowed: boolean) {
  const resolve = leaveResolver.value;
  leaveResolver.value = null;
  resolve?.(allowed);
}
async function saveBeforeLeave() {
  if (await save()) resolveLeave(true);
}
async function close() {
  if (await requestLeave()) emit("close");
}
function keydown(event: KeyboardEvent) {
  if (leaveResolver.value) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!saving.value) resolveLeave(false);
    }
    if (event.key === "Tab") {
      const buttons = [
        ...(confirmCard.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []),
      ];
      if (!buttons.length) {
        event.preventDefault();
        return;
      }
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
    return;
  }
  if (event.key === "Escape" && layoutMenuOpen.value) {
    event.preventDefault();
    event.stopPropagation();
    layoutDropdown.value?.handleClose();
    return;
  }
  if (event.target instanceof Element && event.target.closest(".el-dropdown, .mindmap-layout-menu"))
    return;
  if (event.key !== "Escape" || canvas.value?.renderer.textEdit.isShowTextEdit()) return;
  event.preventDefault();
  event.stopPropagation();
  if (leaveResolver.value) resolveLeave(false);
  else if (fullscreen.value) void toggleFullscreen();
  else void close();
}
function beforeUnload(event: BeforeUnloadEvent) {
  markChanged();
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
watch(() => props.mapId, load, { immediate: true });
watch(leaveResolver, async (resolver) => {
  if (resolver) {
    previousFocus = document.activeElement as HTMLElement;
    await nextTick();
    confirmCard.value?.querySelector("button")?.focus();
  } else previousFocus?.focus();
});
onMounted(() => {
  document.addEventListener("keydown", keydown, true);
  window.addEventListener("beforeunload", beforeUnload);
});
onBeforeUnmount(() => {
  ++sequence;
  observer?.disconnect();
  canvas.value?.destroy();
  resolveLeave(false);
  document.removeEventListener("keydown", keydown, true);
  window.removeEventListener("beforeunload", beforeUnload);
});
defineExpose({ requestLeave, documentId: () => currentMap.value?.documentId });
</script>
<style lang="scss" src="./MindMapEditor.scss" scoped></style>
