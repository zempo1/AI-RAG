/** 实现业务处理；所属能力：封装大模型的完整回答与流式输出调用。 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/api-error';

export interface VisionImage {
  dataUrl: string;
  label: string;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  constructor(private readonly config: ConfigService) {}

  private async model(apiKey?: string, streaming = false, vision = false): Promise<any> {
    // 优先使用本次请求携带的 Key，否则使用服务端配置。
    const key =
      (vision && this.config.get<string>('VISION_API_KEY')) ||
      apiKey?.trim() ||
      this.config.get<string>('CHAT_API_KEY');
    if (!key)
      throw new ApiError(
        500,
        vision ? '请配置 VISION_API_KEY 或 CHAT_API_KEY' : '请配置 CHAT_API_KEY 或提供 X-Api-Key',
      );
    const model = vision
      ? this.config.get('VISION_MODEL') || 'qwen3.8-flash'
      : this.config.getOrThrow('CHAT_MODEL');
    const { ChatOpenAI } = await import('@langchain/openai');
    return new ChatOpenAI({
      apiKey: key,
      model,
      configuration: {
        baseURL:
          (vision && this.config.get('VISION_BASE_URL')) || this.config.getOrThrow('CHAT_BASE_URL'),
      },
      maxRetries: 0,
      // Qwen hybrid models otherwise spend the first part of the stream reasoning.
      modelKwargs: /^qwen/i.test(model) ? { enable_thinking: false } : {},
      maxTokens: Number(
        this.config.get(vision ? 'VISION_OUTPUT_TOKENS' : 'CHAT_OUTPUT_TOKENS') ||
          (vision ? 8192 : 4096),
      ),
      // Streaming silence is bounded separately by ChatController. Keep an overall
      // ceiling as well, without interrupting a progressing answer after 3 minutes.
      timeout: vision
        ? Number(this.config.get('VISION_TIMEOUT_MS') || 180000)
        : streaming
          ? 600000
          : 180000,
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
        model: this.config.get('VISION_MODEL') || 'qwen3.8-flash',
        images: images.length,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        totalTokens: usage?.total_tokens ?? null,
      }),
    );
  }

  async complete(
    prompt: string,
    apiKey?: string,
    images: VisionImage[] = [],
    signal?: AbortSignal,
  ): Promise<string> {
    const message = await (
      await this.model(apiKey, false, images.length > 0)
    ).invoke(this.input(prompt, images), { signal });
    this.reportUsage(message, images);
    // 输出被长度限制截断时显式失败，避免把不完整回答当成正常完成。
    if (message.response_metadata?.finish_reason === 'length')
      throw new Error('回答达到输出长度上限，请缩小问题范围或分次提问');
    if (typeof message.content !== 'string' || !message.content.trim())
      throw new Error('模型返回空内容或不支持的内容格式');
    return message.content;
  }

  async *stream(
    prompt: string,
    apiKey?: string,
    signal?: AbortSignal,
    images: VisionImage[] = [],
  ): AsyncGenerator<string> {
    const stream = await (
      await this.model(apiKey, true, images.length > 0)
    ).stream(this.input(prompt, images), { signal });
    let hasContent = false;
    let usageMessage: any;
    for await (const chunk of stream) {
      if (chunk.usage_metadata) usageMessage = chunk;
      if (typeof chunk.content === 'string' && chunk.content) {
        hasContent = true;
        yield chunk.content;
      }
      if (chunk.response_metadata?.finish_reason === 'length')
        throw new Error('回答达到输出长度上限，请缩小问题范围或分次提问');
    }
    if (images.length) this.reportUsage(usageMessage || {}, images);
    if (!hasContent) throw new Error('模型返回空答案，请稍后重试');
  }
}
