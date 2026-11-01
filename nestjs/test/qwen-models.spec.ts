import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import { QualityModelsService } from '../src/modules/rag/quality-models.service';
import { validateConfig } from '../src/config/configuration';

it('defaults to Qwen3.7 and rejects unsupported flash dimensions', () => {
  const base = { STORAGE_DRIVER: 'mysql', DB_USER: 'test', DB_PASSWORD: 'test', JWT_SECRET: 'x'.repeat(32) };
  expect(validateConfig(base).EMBEDDING_MODEL).toBe('qwen3.7-text-embedding-flash');
  expect(validateConfig(base).RERANK_MODEL).toBe('qwen3.7-text-rerank');
  expect(() => validateConfig({ ...base, EMBEDDING_DIMENSIONS: 1536 })).toThrow('仅支持');
});

it.each(['qwen3.7-text-rerank', 'gte-rerank-v2'])('uses compatible parameters for %s', async (model) => {
  const mock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    output: { results: [{ index: 0, relevance_score: 0.9 }] },
  })));
  try {
    const service = new QualityModelsService(new ConfigService({ RERANK_MODEL: model, RERANK_API_KEY: 'test' }));
    expect(await service.rerank('问题', ['答案'])).toEqual([{ index: 0, score: 0.9 }]);
    const body = JSON.parse(String(mock.mock.calls[0][1]?.body));
    expect(body.model).toBe(model);
    expect(body.input).toEqual({ query: '问题', documents: ['答案'] });
    expect(body.parameters.top_n).toBe(1);
    if (model === 'qwen3.7-text-rerank') {
      expect(body.parameters.instruct).toContain('answer the query');
      expect(body.parameters).not.toHaveProperty('return_documents');
    } else expect(body.parameters.return_documents).toBe(false);
  } finally { mock.mockRestore(); }
});
