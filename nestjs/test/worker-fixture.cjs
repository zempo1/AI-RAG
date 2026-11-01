// Test-only worker: real Nest/MySQL/BullMQ/Qdrant, deterministic external embeddings.
require('reflect-metadata');
process.env.PROCESS_ROLE = 'worker';
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/app.module');
const { EmbeddingsService } = require('../dist/modules/embeddings/embeddings.service');
const { LlmService } = require('../dist/modules/llm/llm.service');
let context;
(async () => {
  context = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmbeddingsService)
    .useValue({
      embedDocuments: async (texts) => texts.map(() => [1, ...Array(383).fill(0)]),
      embedQuery: async () => [1, ...Array(383).fill(0)],
    })
    .overrideProvider(LlmService)
    .useValue({
      complete: async (prompt) =>
        prompt.startsWith('核查') ? '{"supported":true}' : '原文要求核对证据。[1]',
    })
    .compile();
  await context.init();
  process.send?.({ ready: true });
})().catch((error) => {
  process.send?.({ error: error.message });
  process.exitCode = 1;
});
process.on('message', async (message) => {
  if (message === 'shutdown') {
    await context?.close();
    process.disconnect();
  }
});
