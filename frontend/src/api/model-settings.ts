import request from '../utils/request';

export type ModelRole = 'chat' | 'agent' | 'vision' | 'queryPlan' | 'embedding' | 'rerank';
export type ModelProvider = 'local' | 'dashscope' | 'siliconflow' | 'openai-compatible';
export interface ModelSetting {
  role: ModelRole;
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  source: 'system' | 'custom' | 'chat';
  dimensions?: number;
  sendDimensions?: boolean;
}
export interface ModelSettingInput {
  provider: Exclude<ModelProvider, 'local'>;
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimensions?: number;
  sendDimensions?: boolean;
}
export const getModelSettings = () => request.get<any, ModelSetting[]>('/api/model-settings', { silentError: true });
export const saveModelSetting = (role: ModelRole, input: ModelSettingInput) =>
  request.put<any, ModelSetting>('/api/model-settings/' + role, input, { silentError: true });
export const resetModelSetting = (role: ModelRole) =>
  request.delete<any, ModelSetting>('/api/model-settings/' + role, { silentError: true });
