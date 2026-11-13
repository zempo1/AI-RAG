import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Store } from '../../persistence/store';
import { ApiError } from '../../common/api-error';
import { decryptModelSecret, encryptModelSecret, environmentBindings, MODEL_ROLES, ModelBinding,
  ModelProvider, ModelRole, ModelRuntimeSnapshot, normalizedModelUrl } from './model-runtime';

export interface SaveModelSetting {
  provider: Exclude<ModelProvider, 'local'>;
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimensions?: number;
  sendDimensions?: boolean;
}
export interface ModelSettingView extends Omit<ModelBinding, 'apiKey' | 'custom'> {
  role: ModelRole;
  hasApiKey: boolean;
  source: 'system' | 'custom' | 'chat';
}

@Injectable()
export class ModelSettingsService {
  constructor(private readonly store: Store, private readonly config: ConfigService) {}
  private role(value: string): ModelRole {
    if (!(MODEL_ROLES as readonly string[]).includes(value)) throw new ApiError(400, '未知模型用途');
    return value as ModelRole;
  }
  private async resolveBindings(userId: number, secrets: boolean): Promise<ModelRuntimeSnapshot> {
    const bindings = environmentBindings(this.config);
    const rows = await this.store.list('modelSettings', { userId });
    for (const row of rows) {
      const role = this.role(row.role);
      bindings[role] = { ...row.binding, apiKey: secrets
        ? decryptModelSecret(this.config, row.encryptedApiKey, `${userId}/${role}`)
        : row.encryptedApiKey ? 'configured' : undefined, custom: true } as ModelBinding;
    }
    if (!rows.some(r => r.role === 'agent') && bindings.chat.custom) bindings.agent = { ...bindings.chat };
    return { userId, bindings };
  }
  resolveRuntime(userId: number) { return this.resolveBindings(userId, true); }
  async list(userId: number): Promise<ModelSettingView[]> {
    const { bindings } = await this.resolveBindings(userId, false);
    const explicitAgent = (await this.store.list('modelSettings', { userId, role: 'agent' })).length > 0;
    return MODEL_ROLES.map(role => {
      const { apiKey, custom, ...binding } = bindings[role];
      return { ...binding, role, hasApiKey: !!apiKey,
        source: role === 'agent' && !explicitAgent && bindings.chat.custom ? 'chat' : custom ? 'custom' : 'system' };
    });
  }
  async save(userId: number, rawRole: string, input: SaveModelSetting): Promise<ModelSettingView> {
    const role = this.role(rawRole);
    if (!input || !['dashscope', 'siliconflow', 'openai-compatible'].includes(input.provider) ||
      (role === 'rerank' && input.provider === 'openai-compatible')) throw new ApiError(400, '请选择有效的模型接口协议');
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    if (!model || model.length > 255) throw new ApiError(400, '请输入有效的模型名称（最多255字符）');
    let baseUrl: string;
    try {
      if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048) throw new Error();
      baseUrl = normalizedModelUrl(input.baseUrl.trim());
    } catch { throw new ApiError(400, '请输入有效的 HTTP(S) API 地址，不含认证信息、查询参数和片段'); }
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096))
      throw new ApiError(400, 'API Key 格式无效');
    const binding: ModelBinding = { provider: input.provider, model, baseUrl };
    if (role === 'embedding') {
      if (!Number.isSafeInteger(input.dimensions) || input.dimensions! < 1 || input.dimensions! > 65536 || typeof input.sendDimensions !== 'boolean')
        throw new ApiError(400, '请输入有效的向量维度，并选择是否发送 dimensions');
      if (input.provider === 'siliconflow' && /^(Pro\/)?BAAI\/bge-m3$/i.test(model) &&
        (input.dimensions !== 1024 || input.sendDimensions)) throw new ApiError(400, '硅基流动 BGE-M3 必须使用1024维，且不发送 dimensions');
      binding.dimensions = input.dimensions;
      binding.sendDimensions = input.sendDimensions;
    }
    await this.store.transaction(async tx => {
      // Serialize saves for the account, including the first insert of a role.
      await tx.lock('users', userId);
      const rows = await tx.list('modelSettings', { userId });
      const currentRow = rows.find(row => row.role === role) || (role === 'agent' ? rows.find(row => row.role === 'chat') : undefined);
      const current = currentRow?.binding as ModelBinding | undefined;
      const fallback = environmentBindings(this.config)[role];
      let apiKey = input.apiKey?.trim();
      if (!apiKey && normalizedModelUrl(current?.baseUrl || fallback.baseUrl) === baseUrl)
        apiKey = currentRow ? decryptModelSecret(this.config, currentRow.encryptedApiKey, `${userId}/${currentRow.role}`) : fallback.apiKey;
      if (!apiKey) throw new ApiError(400, '首次配置或修改 API 地址时，请填写对应的 API Key');
      const previous = rows.find(row => row.role === role);
      await tx.save('modelSettings', { id: previous?.id, userId, role, binding,
        encryptedApiKey: encryptModelSecret(this.config, apiKey, `${userId}/${role}`) });
    });
    return (await this.list(userId)).find(x => x.role === role)!;
  }
  async reset(userId: number, rawRole: string) {
    const role = this.role(rawRole);
    await this.store.transaction(async tx => {
      await tx.lock('users', userId);
      for (const row of await tx.list('modelSettings', { userId, role })) await tx.delete('modelSettings', row.id);
    });
    return (await this.list(userId)).find(x => x.role === role)!;
  }
}
