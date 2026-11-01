import { ConfigService } from '@nestjs/config';
import {
  currentModelProfile,
  legacyModelProfile,
  profileFingerprint,
} from '../src/modules/embeddings/model-profile';
import { TokenizerService } from '../src/modules/embeddings/tokenizer.service';
import { RecursiveChunker } from '../src/modules/documents/chunkers/recursive.chunker';
import { paragraphBlocks } from '../src/modules/documents/parsers/parsed-document';
import { EmbeddingsService } from '../src/modules/embeddings/embeddings.service';
import { jest } from '@jest/globals';

it('keeps the legacy vector space immutable and makes API profiles independent', () => {
  const config = new ConfigService({
    EMBEDDING_PROVIDER: 'dashscope',
    EMBEDDING_MODEL: 'text-embedding-v4',
    EMBEDDING_DIMENSIONS: 1024,
    EMBEDDING_TOKENIZER: '/models/tokenizer',
  });
  expect(legacyModelProfile(config).dimensions).toBe(384);
  expect(currentModelProfile(config).dimensions).toBe(1024);
  expect(profileFingerprint(currentModelProfile(config))).not.toBe(
    profileFingerprint(legacyModelProfile(config)),
  );
});

it('packs titles with content, preserves pages and records exact parent spans and searchable identifiers', async () => {
  const text = '# 技术\n\nTS-999 对应错误处理。\n\n## 配置\n\n错误码由 API/v2 返回。';
  const tokenizer = new TokenizerService(new ConfigService({ STORAGE_DRIVER: 'memory' }));
  const blocks = paragraphBlocks(text, 1);
  const chunks = await new RecursiveChunker().splitTokenStructured({ text, blocks }, tokenizer, {
    ...legacyModelProfile(),
    tokenizer: 'test:unicode-v1',
  });
  expect(chunks.length).toBe(2);
  expect(chunks[0].text).toContain('# 技术');
  expect(chunks[0].text).toContain('TS-999');
  expect(chunks[0].retrievalMetadata.terms).toMatchObject({ 'ts-999': 1 });
  for (const c of chunks) {
    expect(text.slice(c.location.start, c.location.end)).toBe(c.text);
    const span = c.retrievalMetadata.parentLocation as { start: number; end: number };
    expect(text.slice(span.start, span.end)).toBe(c.retrievalMetadata.parentText);
    expect(c.location.page).toBe(1);
  }
  expect(chunks[1].location.headingPath).toEqual(['技术', '配置']);
});

it('validates API vector indexes and dimensions without calling live services', async () => {
  const config = new ConfigService({
    STORAGE_DRIVER: 'memory',
    EMBEDDING_PROVIDER: 'dashscope',
    EMBEDDING_MODEL: 'text-embedding-v4',
    EMBEDDING_DIMENSIONS: 1024,
    EMBEDDING_TOKENIZER: 'test:unicode-v1',
    EMBEDDING_API_KEY: 'test-key',
    EMBEDDING_BASE_URL: 'http://example.invalid/v1',
  });
  const service = new EmbeddingsService(config);
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(1024).fill(1) }] }), {
        status: 200,
      }),
    );
  try {
    expect((await service.embedQuery('中文问题')).length).toBe(1024);
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ index: 1, embedding: [1] }] }), { status: 200 }),
    );
    await expect(service.embedQuery('错误响应')).rejects.toThrow('Invalid API embedding response');
    fetch.mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(service.embedQuery('限流')).rejects.toThrow('429');
  } finally {
    fetch.mockRestore();
    await service.onModuleDestroy();
  }
});

it('uses token-budgeted exact source windows and rejects unavailable tokenizers', async () => {
  const tokens = new TokenizerService(
    new ConfigService({ STORAGE_DRIVER: 'memory', CHAT_TOKENIZER: 'test:unicode-v1' }),
  );
  const text = '中文标题。\n\n正文 Alpha TS-999 '.repeat(20);
  const windows = await tokens.windows(text, 30, 5, 'test:unicode-v1');
  expect(windows.length).toBeGreaterThan(1);
  for (const window of windows) {
    expect(text.slice(window.start, window.end)).toBe(window.text);
    expect(window.tokenCount).toBeLessThanOrEqual(30);
  }
  await expect(tokens.count('正文', '/definitely/missing/tokenizer')).rejects.toThrow();
});

it('runs without tokenizer files using an explicitly versioned conservative estimate', async () => {
  const config = new ConfigService({ STORAGE_DRIVER: 'mysql' });
  const tokens = new TokenizerService(config);
  expect(currentModelProfile(config).tokenizer).toBe('estimate:utf8-v1');
  const text = '中文😀 Alpha '.repeat(10);
  expect(await tokens.count(text)).toBe(Buffer.byteLength(text, 'utf8'));
  const windows = await tokens.windows(text, 32, 8, 'estimate:utf8-v1');
  expect(windows.length).toBeGreaterThan(1);
  for (const w of windows) {
    expect(text.slice(w.start, w.end)).toBe(w.text);
    expect(Buffer.byteLength(w.text, 'utf8')).toBeLessThanOrEqual(32);
    expect(w.text).not.toContain('�');
  }
});
