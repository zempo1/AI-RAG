/** 实现业务处理；所属能力：封装大模型的完整回答与流式输出调用。 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from '../../common/api-error';
import { modelBinding, redactModelError } from '../model-settings/model-runtime';
import { ModelUsage, ModelOutputError, ModelExecutionOptions, ModelCallRequest, ModelCallOutcome, ToolMessage, ToolDefinition, ToolInvocationOptions, ToolInvocationResult } from './llm.types';
export * from './llm.types';

export interface VisionImage {
  dataUrl: string;
  label: string;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  constructor(private readonly config: ConfigService) {}

  private async model(apiKey?: string, streaming = false, vision = false, execution: ModelExecutionOptions = {}): Promise<any> {
    const binding = modelBinding(this.config, vision ? 'vision' : execution.role || 'chat');
    // Account bindings are indivisible; stale browser headers cannot override their credential.
    const key = binding.custom ? binding.apiKey :
      (vision && this.config.get<string>('VISION_API_KEY')) || apiKey?.trim() || binding.apiKey;
    if (!key)
      throw new ApiError(
        500,
        vision ? '请配置 VISION_API_KEY 或 CHAT_API_KEY' : '请配置 CHAT_API_KEY 或提供 X-Api-Key',
      );
    const model = binding.custom || vision ? binding.model : execution.model || binding.model;
    const { ChatOpenAI } = await import('@langchain/openai');
    return new ChatOpenAI({
      apiKey: key,
      model,
      configuration: {
        baseURL: binding.baseUrl,
      },
      maxRetries: 0,
      // Provider-specific switches must not be sent to thinking-only routes.
      // DashScope's native kimi-k3 models support this; kimi/kimi-k3 does not.
      modelKwargs: /^qwen/i.test(model)
        ? { enable_thinking: execution.thinking ?? false }
        : binding.provider === 'dashscope' && /^kimi-k3(?:\.1-pro)?$/i.test(model) && execution.thinking !== undefined
          ? { enable_thinking: execution.thinking }
          : {},
      maxTokens: this.outputTokens(execution, vision),
      // Streaming silence is bounded separately by ChatController. Keep an overall
      // ceiling as well, without interrupting a progressing answer after 3 minutes.
      timeout: execution.timeoutMs ?? (vision
        ? Number(this.config.get('VISION_TIMEOUT_MS') || 180000)
        : streaming
          ? 600000
          : 180000),
    });
  }

  private input(prompt: string, images: VisionImage[]) {
    if (!images.length) return prompt;
    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images.flatMap((image) => [
            { type: 'text', text: image.label },
            { type: 'image_url', image_url: { url: image.dataUrl } },
          ]),
        ],
      },
    ];
  }

  private reportUsage(message: any, images: VisionImage[]) {
    if (!images.length) return;
    const usage = message.usage_metadata;
    this.logger.log(
      JSON.stringify({
        event: 'vision_usage',
        model: modelBinding(this.config, 'vision').model,
        images: images.length,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        totalTokens: usage?.total_tokens ?? null,
      }),
    );
  }

  private usage(message: any): ModelUsage | undefined {
    const usage = message?.usage_metadata;
    if (!usage) return undefined;
    return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens };
  }

  private signal(signal?: AbortSignal, execution?: ModelExecutionOptions) {
    const signals = [signal, execution?.signal].filter(Boolean) as AbortSignal[];
    return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  }

  private request(kind: ModelCallRequest['kind'], input: unknown, execution: ModelExecutionOptions, vision = false): ModelCallRequest {
    const binding = modelBinding(this.config, vision ? 'vision' : execution.role || 'chat');
    return { kind, input, model: binding.custom || vision ? binding.model : execution.model || binding.model, maxOutputTokens: this.outputTokens(execution, vision) };
  }

  private outputTokens(execution: ModelExecutionOptions, vision: boolean): number {
    return execution.maxOutputTokens ?? Number(this.config.get(vision ? 'VISION_OUTPUT_TOKENS' : 'CHAT_OUTPUT_TOKENS') || (vision ? 8192 : 4096));
  }

  private async observed<T>(request: ModelCallRequest, execution: ModelExecutionOptions, operation: (record: (message: any) => void) => Promise<T>): Promise<T> {
    execution.signal?.throwIfAborted();
    const reservation = await execution.observer?.before(request);
    let usage: ModelUsage | undefined;
    let outcome: ModelCallOutcome;
    let result: T;
    try {
      execution.signal?.throwIfAborted();
      result = await operation(message => { usage = this.usage(message) || usage; });
      execution.signal?.throwIfAborted();
      outcome = { status: 'success', usage };
    } catch (error) {
      const safe = redactModelError(this.config, error, (execution as ToolInvocationOptions).apiKey);
      outcome = { status: execution.signal?.aborted ? 'cancelled' : 'error', usage, error: safe };
      if (reservation !== undefined) await execution.observer!.settle(reservation, outcome);
      throw safe;
    }
    if (reservation !== undefined) await execution.observer!.settle(reservation, outcome);
    return result!;
  }

  async complete(prompt: string, apiKey?: string, images: VisionImage[] = [], signal?: AbortSignal, execution: ModelExecutionOptions = {}): Promise<string> {
    const options = { ...execution, apiKey, signal: this.signal(signal, execution) };
    const input = this.input(prompt, images);
    return this.observed(this.request('complete', input, execution, images.length > 0), options, async record => {
      const model = await this.model(apiKey, false, images.length > 0, execution);
      let message: any;
      try {
        message = await model.invoke(input, { signal: options.signal,
          ...(execution.json ? { response_format: { type: 'json_object' } } : {}) });
      } catch (error: any) {
        // Some compatible endpoints explicitly reject this optional parameter.
        // Authentication, overload and generic bad requests must remain failures.
        const unsupported = execution.json && [400, 422].includes(Number(error.status)) &&
          /response_format/i.test(String(error.message)) &&
          /not supported|unsupported|unknown parameter|unrecognized|not allowed|不支持/i.test(String(error.message));
        if (!unsupported) throw error;
        options.signal?.throwIfAborted();
        this.logger.warn(JSON.stringify({ event: 'llm-json-mode-unsupported',
          model: modelBinding(this.config, images.length ? 'vision' : execution.role || 'chat').model }));
        message = await model.invoke(input, { signal: options.signal });
      }
      record(message);
      this.reportUsage(message, images);
      if (message.response_metadata?.finish_reason === 'length') throw new ModelOutputError('回答达到输出长度上限，请缩小问题范围或分次提问');
      if (typeof message.content !== 'string' || !message.content.trim()) throw new ModelOutputError('模型返回空内容或不支持的内容格式');
      return message.content;
    });
  }

  async invokeTools(messages: ToolMessage[], tools: ToolDefinition[], options: ToolInvocationOptions = {}): Promise<ToolInvocationResult> {
    return this.observed(this.request('tools', { messages, tools }, options), options, async record => {
      const model = await this.model(options.apiKey, false, false, options);
      const message = await model.bindTools(tools).invoke(messages, { signal: options.signal });
      record(message);
      const finishReason = message.response_metadata?.finish_reason;
      if (finishReason === 'length') throw new Error('回答达到输出长度上限，请缩小问题范围或分次提问');
      if (message.invalid_tool_calls?.length) throw new Error('模型返回非法工具调用参数');
      const calls = message.tool_calls || [];
      if (calls.some((call: any) => !call.id || !call.name || !call.args || typeof call.args !== 'object' || Array.isArray(call.args))) throw new Error('模型返回非法工具调用');
      if (typeof message.content !== 'string' || (!message.content.trim() && !calls.length)) throw new Error('模型返回空内容或不支持的内容格式');
      return { content: message.content, toolCalls: calls.map((call: any) => ({ id: call.id, name: call.name, args: call.args })), usage: this.usage(message), finishReason };
    });
  }

  async *stream(prompt: string, apiKey?: string, signal?: AbortSignal, images: VisionImage[] = [], execution: ModelExecutionOptions = {}): AsyncGenerator<string> {
    const mergedSignal = this.signal(signal, execution);
    mergedSignal?.throwIfAborted();
    const input = this.input(prompt, images);
    const timeout = execution.timeoutMs ?? (images.length ? Number(this.config.get('VISION_TIMEOUT_MS') || 180000) : 600000);
    const deadline = Date.now() + timeout;
    const connectionTimeout = () => Object.assign(new Error('模型服务连接超时，尚未收到回答正文，请稍后重试'), { name: 'TimeoutError' });
    const remaining = () => {
      const value = deadline - Date.now();
      if (value <= 0) throw connectionTimeout();
      return value;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      remaining();
      const reservation = await execution.observer?.before(this.request('stream', input, execution, images.length > 0));
      let usage: ModelUsage | undefined, usageMessage: any, completed = false, error: unknown;
      let hasContent = false, retry = false;
      try {
        mergedSignal?.throwIfAborted();
        const model = await this.model(apiKey, true, images.length > 0, { ...execution, timeoutMs: remaining() });
        if (attempt) this.logger.warn(JSON.stringify({ event: 'llm-stream-retry', reason: 'timeout-before-content', attempt: 2 }));
        const stream = await model.stream(input, { signal: mergedSignal, timeout: remaining() });
        for await (const chunk of stream) {
          mergedSignal?.throwIfAborted();
          if (chunk.usage_metadata) { usageMessage = chunk; usage = this.usage(chunk); }
          if (typeof chunk.content === 'string' && chunk.content) { hasContent = true; yield chunk.content; }
          if (chunk.response_metadata?.finish_reason === 'length') throw new Error('回答达到输出长度上限，请缩小问题范围或分次提问');
        }
        if (images.length) this.reportUsage(usageMessage || {}, images);
        if (!hasContent) throw new Error('模型返回空答案，请稍后重试');
        mergedSignal?.throwIfAborted();
        completed = true;
      } catch (caught) {
        const timedOut = caught instanceof Error && ['TimeoutError', 'APIConnectionTimeoutError'].includes(caught.name);
        retry = timedOut && !images.length && !hasContent && !mergedSignal?.aborted &&
          attempt === 0 && deadline - Date.now() > 250;
        error = redactModelError(this.config, caught, apiKey);
        if (!retry) {
          if (timedOut && !mergedSignal?.aborted) {
            error = Object.assign(new Error(hasContent
              ? '模型响应超时，已生成的内容已保留，请稍后重试'
              : '模型服务连接超时，尚未收到回答正文，请稍后重试'), { name: 'TimeoutError' });
          }
          throw error;
        }
      } finally {
        if (reservation !== undefined) await execution.observer!.settle(reservation, { status: completed ? 'success' : mergedSignal?.aborted || error === undefined ? 'cancelled' : 'error', usage, error });
      }
      if (completed) return;
      if (remaining() <= 250) throw connectionTimeout();
      await delay(250, undefined, { signal: mergedSignal });
    }
  }
}
