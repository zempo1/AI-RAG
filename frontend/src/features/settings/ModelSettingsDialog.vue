<template>
  <el-dialog v-model="visible" title="模型设置" width="min(680px, calc(100vw - 32px))"
    :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" class="model-settings-dialog">
    <p class="settings-intro">配置保存在当前账号，保存后新请求和新任务立即生效。</p>
    <el-tabs v-model="role" :before-leave="() => !saving">
      <el-tab-pane v-for="item in roles" :key="item.value" :label="item.label" :name="item.value" />
    </el-tabs>
    <div v-loading="loading" class="settings-body">
      <template v-if="current">
        <div class="settings-source">
          <el-tag size="small" :type="current.source === 'system' ? 'info' : 'success'">{{ sourceLabel }}</el-tag>
          <span>{{ descriptions[role] }}</span>
        </div>
        <el-form ref="form" :model="draft" :rules="rules" label-position="top" @submit.prevent="save">
          <el-form-item label="接口协议" for="model-provider" prop="provider">
            <el-select id="model-provider" v-model="draft.provider" aria-label="接口协议" popper-class="model-settings-provider-popper" :disabled="saving" @change="chooseProvider">
              <el-option v-if="draft.provider === 'local'" label="本地模型（服务端默认）" value="local" disabled />
              <el-option label="阿里云百炼" value="dashscope" />
              <el-option label="硅基流动" value="siliconflow" />
              <el-option v-if="role !== 'rerank'" label="其他 OpenAI 兼容接口" value="openai-compatible" />
            </el-select>
          </el-form-item>
          <el-form-item label="API 地址" for="model-base-url" prop="baseUrl">
            <el-input id="model-base-url" v-model="draft.baseUrl" :disabled="saving || draft.provider === 'local'" placeholder="https://api.siliconflow.cn/v1" />
            <span class="field-hint">{{ role === 'rerank' ? '填写完整重排接口地址，例如 https://api.siliconflow.cn/v1/rerank' : '填写 Base URL，包含 /v1 等前缀，不包含 /chat/completions 或 /embeddings。' }}</span>
          </el-form-item>
          <el-form-item label="模型名称" for="model-name" prop="model">
            <el-input id="model-name" v-model="draft.model" :disabled="saving || draft.provider === 'local'" placeholder="填写服务商提供的完整模型名称" />
          </el-form-item>
          <el-form-item label="API Key" for="model-api-key" prop="apiKey">
            <el-input id="model-api-key" v-model="draft.apiKey" type="password" show-password autocomplete="new-password"
              :disabled="saving || draft.provider === 'local'" :placeholder="hasApiKey ? '已配置，留空保持不变' : '请输入当前服务的 API Key'" />
            <span class="field-hint">{{ hasApiKey ? '已配置 · 留空保持不变，修改地址时需填写对应的 Key。' : '首次配置需填写 Key；保存后不回显。' }}</span>
          </el-form-item>
          <div v-if="role === 'chat' && legacyKey" class="legacy-import">
            <span>检测到此浏览器保存的旧 Key。</span>
            <el-button link type="primary" :disabled="saving" @click="importLegacy">导入旧浏览器 Key</el-button>
          </div>
          <div v-if="role === 'embedding'" class="embedding-options">
            <el-form-item label="向量维度" for="model-dimensions" prop="dimensions">
              <el-input-number id="model-dimensions" v-model="draft.dimensions" :min="1" :max="65536" :disabled="saving || isBge || draft.provider === 'local'" />
            </el-form-item>
            <el-form-item label="发送 dimensions" for="model-send-dimensions">
              <el-switch id="model-send-dimensions" v-model="draft.sendDimensions" aria-label="发送 dimensions" :disabled="saving || isBge || draft.provider === 'local'" />
            </el-form-item>
            <p class="field-hint" v-if="isBge">BGE-M3 固定为 1024 维，硅基流动接口不发送 dimensions 参数。</p>
          </div>
          <el-alert v-if="role === 'embedding'" type="warning" :closable="false" show-icon
            title="更换 API 地址、向量模型或维度后，已有文档需手动重建索引；只更换 Key 无需重建。" />
          <p v-if="draft.provider === 'local'" class="field-hint">选择远程接口协议后，可填写并保存新的向量模型配置。</p>
        </el-form>
      </template>
      <el-alert v-if="error" class="settings-error" :title="error" type="error" :closable="false" show-icon />
      <el-button v-if="!current && error" @click="load">重新加载</el-button>
    </div>
    <template #footer>
      <div class="settings-footer">
        <el-button :disabled="saving || loading || !current" @click="reset">恢复服务端默认</el-button>
        <div>
          <el-button :disabled="saving" @click="visible = false">关闭</el-button>
          <el-button type="primary" :loading="saving" :disabled="cannotSave" @click="save">保存当前配置</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { getModelSettings, saveModelSetting, resetModelSetting, type ModelRole, type ModelSetting, type ModelSettingInput, type ModelProvider } from '../../api/model-settings';
import { toast } from '../../composables/useToast';

const roles = [{ value: 'chat', label: '对话' }, { value: 'agent', label: 'Agent' }, { value: 'vision', label: '图片理解' },
  { value: 'queryPlan', label: '查询规划' }, { value: 'embedding', label: '向量化' }, { value: 'rerank', label: '重排' }] as const;
const descriptions: Record<ModelRole, string> = { chat: '最终回答、文档分析与思维导图。', agent: '规划、工具调用与证据评估，未单独配置时跟随自定义对话模型。',
  vision: 'PDF 图片、表格和扫描内容的理解。', queryPlan: '查询改写与检索规划。', embedding: '文档和问题的向量化，必须使用同一模型。', rerank: '对检索候选片段重新排序。' };
const visible = ref(false), loading = ref(false), saving = ref(false), error = ref('');
const role = ref<ModelRole>('chat'), settings = ref<ModelSetting[]>([]), form = ref<FormInstance>();
const legacyKey = ref('');
let importing = false, generation = 0;
const current = computed(() => settings.value.find(item => item.role === role.value));
const hasApiKey = computed(() => !!current.value?.hasApiKey);
const sourceLabel = computed(() => current.value?.source === 'chat' ? '跟随对话配置' : current.value?.source === 'custom' ? '当前账号配置' : '服务端默认');
const draft = reactive({ provider: 'openai-compatible' as ModelProvider, baseUrl: '', model: '', apiKey: '', dimensions: 1024, sendDimensions: true });
const cannotSave = computed(() => loading.value || !current.value || draft.provider === 'local');
const isBge = computed(() => role.value === 'embedding' && draft.provider === 'siliconflow' && /^(Pro\/)?BAAI\/bge-m3$/i.test(draft.model.trim()));
const normalize = (value: string) => { try { return new URL(value.trim()).toString().replace(/\/+$/, ''); } catch { return value.trim(); } };
const rules: FormRules = {
  baseUrl: [{ validator: (_rule, value, callback) => {
    try {
      const url = new URL(value.trim());
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      callback();
    } catch { callback(new Error('请输入有效的 HTTP(S) API 地址')); }
  }, trigger: 'blur' }],
  model: [{ validator: (_rule, value, callback) => callback(typeof value === 'string' && value.trim() && value.trim().length <= 255 ? undefined : new Error('请输入有效的模型名称')), trigger: 'blur' }],
  apiKey: [{ validator: (_rule, value, callback) => {
    if (!String(value).trim() && (!current.value?.hasApiKey || normalize(draft.baseUrl) !== normalize(current.value.baseUrl)))
      callback(new Error('首次配置或修改 API 地址时请填写对应的 Key'));
    else callback();
  }, trigger: 'blur' }],
  dimensions: [{ validator: (_rule, value, callback) => callback(Number.isSafeInteger(value) && value >= 1 && value <= 65536 ? undefined : new Error('请输入有效的向量维度')), trigger: 'blur' }],
};
function fill() {
  const item = current.value;
  if (!item) return;
  Object.assign(draft, { provider: item.provider, baseUrl: item.baseUrl, model: item.model, apiKey: '',
    dimensions: item.dimensions ?? 1024, sendDimensions: item.sendDimensions ?? true });
  importing = false;
  error.value = '';
  form.value?.clearValidate();
}
watch(role, fill);
watch(isBge, value => { if (value) { draft.dimensions = 1024; draft.sendDimensions = false; } });
watch(visible, value => {
  if (!value) { generation++; draft.apiKey = ''; settings.value = []; legacyKey.value = ''; }
});
async function load() {
  const request = ++generation;
  loading.value = true; error.value = '';
  try {
    const result = await getModelSettings();
    if (request !== generation) return;
    settings.value = result; fill();
  } catch (failure: any) { if (request === generation) error.value = failure.response?.data?.message || '加载模型配置失败，请重试'; }
  finally { if (request === generation) loading.value = false; }
}
function open() {
  role.value = 'chat'; visible.value = true;
  legacyKey.value = localStorage.getItem('user_api_key') || '';
  void load();
}
function chooseProvider() {
  if (draft.provider === 'siliconflow') draft.baseUrl = 'https://api.siliconflow.cn/v1' + (role.value === 'rerank' ? '/rerank' : '');
  else if (draft.provider === 'dashscope') draft.baseUrl = role.value === 'rerank'
    ? 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank' : 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  if (role.value === 'embedding') draft.sendDimensions = draft.provider === 'dashscope';
}
function importLegacy() { draft.apiKey = legacyKey.value; importing = true; form.value?.clearValidate('apiKey'); }
async function save() {
  if (!current.value || saving.value) return;
  if (!(await form.value?.validate().catch(() => false))) return;
  saving.value = true; error.value = '';
  try {
    const input: ModelSettingInput = { provider: draft.provider as ModelSettingInput['provider'], baseUrl: draft.baseUrl.trim(), model: draft.model.trim(),
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      ...(role.value === 'embedding' ? { dimensions: draft.dimensions, sendDimensions: draft.sendDimensions } : {}) };
    const result = await saveModelSetting(role.value, input);
    if (role.value === 'chat' && importing && input.apiKey === legacyKey.value) { localStorage.removeItem('user_api_key'); legacyKey.value = ''; }
    settings.value = settings.value.map(item => item.role === role.value ? result : item);
    fill(); toast.success('模型配置已保存');
    await load();
  } catch (failure: any) { error.value = failure.response?.data?.message || '保存失败，请重试'; }
  finally { saving.value = false; }
}
async function reset() {
  if (!current.value || saving.value) return;
  saving.value = true; error.value = '';
  try {
    const result = await resetModelSetting(role.value);
    settings.value = settings.value.map(item => item.role === role.value ? result : item);
    fill(); toast.success('已恢复服务端默认配置'); await load();
  } catch (failure: any) { error.value = failure.response?.data?.message || '恢复失败，请重试'; }
  finally { saving.value = false; }
}
defineExpose({ open });
</script>

<style scoped lang="scss">
:global(.model-settings-dialog), :global(.model-settings-provider-popper) {
  --el-color-primary: var(--accent-color);
  --el-bg-color: var(--bg-card);
  --el-bg-color-overlay: var(--bg-card);
  --el-fill-color-blank: var(--bg-card);
  --el-fill-color: var(--bg-hover);
  --el-fill-color-light: var(--bg-hover);
  --el-fill-color-lighter: var(--bg-hover);
  --el-fill-color-extra-light: var(--bg-hover);
  --el-disabled-bg-color: var(--bg-hover);
  --el-text-color-primary: var(--text-primary);
  --el-text-color-regular: var(--text-primary);
  --el-text-color-secondary: var(--text-secondary);
  --el-border-color: var(--border-color);
  --el-border-color-light: var(--border-color);
  --el-border-color-lighter: var(--border-color);
}
:global(.model-settings-dialog) {
  display: flex;
  flex-direction: column;
  margin: 32px auto;
  max-height: calc(100dvh - 64px);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 0;
  overflow: hidden;
  text-align: left;
}
:global(.model-settings-dialog .el-dialog__header) { padding: 20px 24px; margin: 0; border-bottom: 1px solid var(--border-color); }
:global(.model-settings-dialog .el-dialog__body) { padding: 20px; min-height: 0; overflow-y: auto; }
:global(.model-settings-dialog .el-dialog__footer) { padding: 16px 20px; border-top: 1px solid var(--border-color); }
.settings-intro, .field-hint, .settings-source, .legacy-import { color: var(--text-secondary, #9ca3af); font-size: 13px; line-height: 1.6; }
.settings-intro { margin: 0 0 16px; }
.settings-body { min-height: 200px; }
.settings-source { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
.field-hint { display: block; margin-top: 6px; width: 100%; }
.settings-body :deep(.el-select) { width: 100%; }
.embedding-options { display: flex; flex-wrap: wrap; gap: 0 28px; }
.embedding-options > .field-hint { margin-top: -10px; margin-bottom: 12px; }
.legacy-import { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: -6px 0 18px; }
.settings-error { margin-top: 16px; }
.settings-footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }
.settings-footer > div { display: flex; gap: 10px; }
.settings-footer :deep(.el-button + .el-button) { margin-left: 0; }
</style>
