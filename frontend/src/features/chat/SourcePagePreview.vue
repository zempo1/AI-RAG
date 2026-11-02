<template>
  <section
    v-if="source.location?.pageImage && !source.sourceDeleted"
    class="page-preview"
    aria-label="来源页面原图"
  >
    <p v-if="loading" role="status">
      正在加载第 {{ source.location.page }} 页原图…
    </p>
    <div v-else-if="error" role="status">
      <p>{{ error }}</p>
      <el-button size="small" @click="attempt++">重新加载原图</el-button>
    </div>
    <template v-else-if="url">
      <a :href="url" target="_blank" rel="noopener"
        >查看完整页面原图（新窗口）</a
      >
      <img
        :src="url"
        :alt="`${source.filename} 第 ${source.location.page} 页原图`"
      />
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { getCitationPageImage, type Citation } from "../../api/knowledge-bases";

const props = defineProps<{ source: Citation }>();
const attempt = ref(0),
  loading = ref(false),
  error = ref(""),
  url = ref("");
watch(
  [() => props.source, attempt],
  async ([source], _, onCleanup) => {
    const controller = new AbortController();
    let objectUrl = "";
    onCleanup(() => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
    url.value = "";
    error.value = "";
    loading.value = false;
    if (!source.location?.pageImage || source.sourceDeleted) return;
    loading.value = true;
    try {
      const blob = await getCitationPageImage(source, controller.signal);
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      url.value = objectUrl;
    } catch {
      if (!controller.signal.aborted)
        error.value = "页面原图暂不可用，可重新加载。识别结果仍显示在上方。";
    } finally {
      if (!controller.signal.aborted) loading.value = false;
    }
  },
  { immediate: true },
);
</script>

<style scoped>
.page-preview {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color);
}
.page-preview p {
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.page-preview a {
  color: var(--el-color-primary);
  text-decoration: underline;
}
.page-preview img {
  display: block;
  width: 100%;
  height: auto;
  margin-top: 12px;
  border: 1px solid var(--el-border-color);
}
</style>
