import { createServer, Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { EmbeddingsService } from '../src/modules/embeddings/embeddings.service';
import { QualityModelsService } from '../src/modules/rag/quality-models.service';

let server: Server, base: string, arrived: () => void;
beforeAll(async () => {
  server = createServer(async (req, _res) => { for await (const _ of req) {} arrived(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:'+(server.address() as any).port;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

it.each(['embedding', 'rerank', 'plan'])('aborts an in-flight %s request without replacing caller cancellation with timeout', async kind => {
  const config = new ConfigService({ EMBEDDING_PROVIDER: 'dashscope', EMBEDDING_API_KEY: 'fixture', EMBEDDING_BASE_URL: base, EMBEDDING_MODEL: 'text-embedding-v4', EMBEDDING_DIMENSIONS: 1024, EMBEDDING_TOKENIZER: 'estimate:utf8-v1', CHAT_API_KEY: 'fixture', QUERY_PLAN_BASE_URL: base, RERANK_URL: base, QUALITY_MODEL_TIMEOUT_MS: 1000 });
  const controller = new AbortController();
  const received = new Promise<void>(resolve => { arrived = resolve; });
  const embedding = new EmbeddingsService(config) as any;
  const quality = new QualityModelsService(config) as any;
  const pending = kind === 'embedding' ? embedding.embedQuery('test', embedding.currentProfile(), controller.signal) : kind === 'rerank' ? quality.rerank('test',['text'],controller.signal) : quality.plan('test',[],[],controller.signal);
  // Install the rejection handler before aborting to avoid unhandled rejections.
  const rejected = expect(pending).rejects.toThrow();
  await received;
  const started = Date.now();
  controller.abort(new Error('user cancelled'));
  await rejected;
  expect(Date.now()-started).toBeLessThan(500);
});
