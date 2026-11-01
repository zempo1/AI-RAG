import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface TokenWindow {
  text: string;
  start: number;
  end: number;
  tokenCount: number;
}
@Injectable()
export class TokenizerService {
  private readonly loaded = new Map<string, Promise<any>>();
  constructor(private readonly config: ConfigService) {}
  private async tokenizer(id?: string) {
    const name =
      id ||
      this.config.get<string>('CHAT_TOKENIZER') ||
      (this.config.get('STORAGE_DRIVER') === 'memory' ? 'test:unicode-v1' : 'estimate:utf8-v1');
    // Conservative byte budget, not a claim of matching the remote tokenizer.
    // Versioned ID is persisted with indexes so future changes cannot reinterpret them.
    if (name === 'estimate:utf8-v1')
      return { encode: (text: string) => ({ length: Buffer.byteLength(text, 'utf8') }) };
    if (!name)
      throw new Error(
        '必须配置与模型匹配的 CHAT_TOKENIZER / EMBEDDING_TOKENIZER，不能用字符数代替 token 数',
      );
    if (name === 'test:unicode-v1') {
      if (this.config.get('STORAGE_DRIVER') !== 'memory')
        throw new Error('测试 tokenizer 仅可用于 memory 模式');
      return { encode: (text: string) => Array.from(text) };
    }
    if (isAbsolute(name) && !existsSync(name)) throw new Error('Tokenizer 路径不存在');
    if (!this.loaded.has(name))
      this.loaded.set(
        name,
        (async () => {
          const { AutoTokenizer, env } = await import('@huggingface/transformers');
          env.cacheDir = this.config.get('MODEL_CACHE_DIR') || '.cache/models';
          return AutoTokenizer.from_pretrained(name, { local_files_only: true });
        })().catch((error) => {
          this.loaded.delete(name);
          throw error;
        }),
      );
    return this.loaded.get(name)!;
  }
  async count(text: string, tokenizerId?: string) {
    const tokenizer = await this.tokenizer(tokenizerId);
    return tokenizer.encode(text, { add_special_tokens: false }).length as number;
  }
  async windows(
    text: string,
    max: number,
    overlap = 0,
    tokenizerId?: string,
  ): Promise<TokenWindow[]> {
    if (max <= overlap || overlap < 0) throw new Error('Invalid token window');
    const tokenizer = await this.tokenizer(tokenizerId);
    const count = (value: string) => tokenizer.encode(value, { add_special_tokens: false }).length;
    const positions = [0];
    for (const char of text) positions.push(positions.at(-1)! + char.length);
    const result: TokenWindow[] = [];
    let cursor = 0;
    while (cursor < positions.length - 1) {
      let low = cursor + 1,
        high = positions.length - 1,
        end = cursor;
      while (low <= high) {
        const mid = (low + high) >>> 1;
        if (count(text.slice(positions[cursor], positions[mid])) <= max) {
          end = mid;
          low = mid + 1;
        } else high = mid - 1;
      }
      if (end === cursor) throw new Error('单个字符超出 token 预算');
      result.push({
        text: text.slice(positions[cursor], positions[end]),
        start: positions[cursor],
        end: positions[end],
        tokenCount: count(text.slice(positions[cursor], positions[end])),
      });
      if (end === positions.length - 1) break;
      let next = end;
      while (next > cursor + 1 && count(text.slice(positions[next - 1], positions[end])) <= overlap)
        next--;
      cursor = Math.max(cursor + 1, next);
    }
    return result;
  }
}
