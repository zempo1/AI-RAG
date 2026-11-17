<template>
  <div class="panel-resize-handle" :class="{ dragging }">
    <div
      class="panel-resize-grip"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      :aria-label="label"
      :aria-valuenow="Math.round(value)"
      :aria-valuemin="Math.round(min)"
      :aria-valuemax="Math.round(max)"
      :aria-controls="controls"
      @pointerdown="start"
      @pointermove="move"
      @pointerup="stop"
      @pointercancel="stop"
      @lostpointercapture="cleanup"
      @keydown="onKey"
      @dblclick="emit('reset')"
    ></div>
  </div>
</template>
<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
const props = defineProps<{
  label: string;
  value: number;
  min: number;
  max: number;
  direction?: 1 | -1;
  controls?: string;
}>();
const emit = defineEmits<{ (e: "resize", value: number): void; (e: "reset"): void }>();
const dragging = ref(false);
let startX = 0,
  startValue = 0,
  previousSelect = "",
  previousCursor = "";
function start(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  startX = event.clientX;
  startValue = props.value;
  dragging.value = true;
  const element = event.currentTarget as HTMLElement;
  element.focus();
  element.setPointerCapture(event.pointerId);
  previousSelect = document.body.style.userSelect;
  previousCursor = document.body.style.cursor;
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
}
function move(event: PointerEvent) {
  if (dragging.value)
    emit("resize", startValue + (event.clientX - startX) * (props.direction || 1));
}
function cleanup() {
  if (!dragging.value) return;
  dragging.value = false;
  document.body.style.userSelect = previousSelect;
  document.body.style.cursor = previousCursor;
}
function stop(event: PointerEvent) {
  const element = event.currentTarget as HTMLElement;
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  cleanup();
}
function onKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 48 : 16;
  const values: Record<string, number> = {
    ArrowLeft: props.value - step * (props.direction || 1),
    ArrowRight: props.value + step * (props.direction || 1),
    Home: props.min,
    End: props.max,
  };
  if (event.key in values) {
    event.preventDefault();
    emit("resize", values[event.key]);
  }
}
onBeforeUnmount(cleanup);
</script>
<style scoped>
.panel-resize-handle {
  width: 6px;
  flex: 0 0 6px;
  position: relative;
  cursor: col-resize;
  touch-action: none;
  z-index: 10;
  outline: none;
  background: transparent;
}
.panel-resize-grip {
  height: 100%;
  outline: none;
}
.panel-resize-grip:before {
  content: "";
  position: absolute;
  inset: 0 -3px;
}
</style>
