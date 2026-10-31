<template>
  <el-dialog
    v-model="visible"
    :title="title"
    class="knowledge-theme knowledge-form"
    width="460px"
    append-to-body
    :close-on-click-modal="false"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    @closed="reset"
  >
    <el-form
      ref="form"
      :model="values"
      label-position="top"
      @submit.prevent="save"
    >
      <el-form-item
        label="名称"
        prop="name"
        :rules="[{ validator: validateName, trigger: 'blur' }]"
      >
        <el-input
          v-model="values.name"
          maxlength="120"
          autofocus
          :disabled="saving"
          placeholder="输入名称"
        />
      </el-form-item>
      <el-form-item
        v-if="withDescription"
        label="描述"
        prop="description"
        :rules="[{ max: 2000, message: '最多 2000 个字符', trigger: 'blur' }]"
      >
        <el-input
          v-model="values.description"
          type="textarea"
          :rows="3"
          maxlength="2000"
          :disabled="saving"
          placeholder="简单介绍这个知识库（选填）"
        />
      </el-form-item>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div class="form-actions">
        <el-button :disabled="saving" @click="visible = false">取消</el-button
        ><el-button
          class="gradient-button"
          :loading="saving"
          native-type="submit"
          >保存</el-button
        >
      </div>
    </el-form>
  </el-dialog>
</template>
<script setup lang="ts">
import { reactive, ref } from "vue";
import type { FormInstance } from "element-plus";
const visible = ref(false),
  saving = ref(false),
  title = ref(""),
  withDescription = ref(false),
  error = ref("");
const values = reactive({ name: "", description: "" });
const form = ref<FormInstance>();
let submit: (name: string, description: string) => Promise<unknown>;
function validateName(
  _rule: unknown,
  value: string,
  callback: (error?: Error) => void,
) {
  callback(
    value?.trim() && value.trim().length <= 120
      ? undefined
      : new Error("名称须为 1～120 个字符"),
  );
}
function open(options: {
  title: string;
  name?: string;
  description?: string;
  onSave: typeof submit;
}) {
  title.value = options.title;
  values.name = options.name || "";
  values.description = options.description || "";
  withDescription.value = options.description !== undefined;
  submit = options.onSave;
  error.value = "";
  visible.value = true;
}
function reset() {
  form.value?.clearValidate();
  error.value = "";
}
async function save() {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    if (!(await form.value?.validate().catch(() => false))) return;
    await submit(values.name.trim(), values.description);
    visible.value = false;
  } catch {
    error.value = "保存失败，请检查后重试。";
  } finally {
    saving.value = false;
  }
}
defineExpose({ open });
</script>
