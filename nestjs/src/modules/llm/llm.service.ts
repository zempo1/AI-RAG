/** 实现业务处理；所属能力：封装大模型的完整回答与流式输出调用。 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/api-error';

@Injectable()
export class LlmService {
  constructor(private readonly config: ConfigService) {}

  private async model(apiKey?: string, streaming = false): Promise<any> {
    // 优先使用本次请求携带的 Key，否则使用服务端配置。
    const key = apiKey?.trim() || this.config.get<string>('CHAT_API_KEY');
    if (!key) throw new ApiError(500, '请配置 CHAT_API_KEY 或提供 X-Api-Key');
    const { ChatOpenAI } = await import('@langchain/openai');
    return new ChatOpenAI({
      apiKey: key,
      model: this.config.getOrThrow('CHAT_MODEL'),
      configuration: { baseURL: this.config.getOrThrow('CHAT_BASE_URL') },
      maxRetries: 0,
      // Qwen hybrid models otherwise spend the first part of the stream reasoning.
      modelKwargs: /^qwen/i.test(this.config.getOrThrow('CHAT_MODEL'))
        ? { enable_thinking: false }
        : {},
      maxTokens: Number(this.config.get('CHAT_OUTPUT_TOKENS') || 4096),
      // Streaming silence is bounded separately by ChatController. Keep an overall
      // ceiling as well, without interrupting a progressing answer after 3 minutes.
      timeout: streaming ? 600000 : 180000,
    });
  }

  async complete(prompt: string, apiKey?: string): Promise<string> {
    const message = await (await this.model(apiKey)).invoke(prompt);
    // 输出被长度限制截断时显式失败，避免把不完整回答当成正常完成。
    if (message.response_metadata?.finish_reason === 'length')
      throw new Error('回答达到输出长度上限，请缩小问题范围或分次提问');
    if (typeof message.content !== 'string' || !message.content.trim())
      throw new Error('模型返回空内容或不支持的内容格式');
    return message.content;
  }

  async *stream(prompt: string, apiKey?: string, signal?: AbortSignal): AsyncGenerator<string> {
    const stream = await (await this.model(apiKey, true)).stream(prompt, { signal });
    let hasContent = false;
    for await (const chunk of stream) {
      if (typeof chunk.content === 'string' && chunk.content) {
        hasContent = true;
        yield chunk.content;
      }
      if (chunk.response_metadata?.finish_reason === 'length')
        throw new Error('回答达到输出长度上限，请缩小问题范围或分次提问');
    }
    if (!hasContent) throw new Error('模型返回空答案，请稍后重试');
  }
}
