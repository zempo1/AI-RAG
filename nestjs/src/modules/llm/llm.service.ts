import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/api-error';

@Injectable()
export class LlmService {
  constructor(private readonly config: ConfigService) {}

  private async model(apiKey?: string): Promise<any> {
    const key = apiKey?.trim() || this.config.get<string>('CHAT_API_KEY');
    if (!key) throw new ApiError(500, '请配置 CHAT_API_KEY 或提供 X-Api-Key');
    const { ChatOpenAI } = await import('@langchain/openai');
    return new ChatOpenAI({
      apiKey: key,
      model: this.config.getOrThrow('CHAT_MODEL'),
      configuration: { baseURL: this.config.getOrThrow('CHAT_BASE_URL') },
      maxRetries: 0,
      timeout: 180000,
    });
  }

  async complete(prompt: string, apiKey?: string): Promise<string> {
    const message = await (await this.model(apiKey)).invoke(prompt);
    if (typeof message.content !== 'string' || !message.content.trim())
      throw new Error('模型返回空内容或不支持的内容格式');
    return message.content;
  }

  async *stream(prompt: string, apiKey?: string, signal?: AbortSignal): AsyncGenerator<string> {
    const stream = await (await this.model(apiKey)).stream(prompt, { signal });
    for await (const chunk of stream) {
      if (typeof chunk.content === 'string' && chunk.content) yield chunk.content;
    }
  }
}
