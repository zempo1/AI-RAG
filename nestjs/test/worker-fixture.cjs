// Test-only worker: real Nest/MySQL/BullMQ/Qdrant, deterministic external embeddings.
require('reflect-metadata');
process.env.PROCESS_ROLE = 'worker';
const { Test } = require('@nestjs/testing');
const { agentLlmFixture } = require('./helpers/agent-llm.fixture.ts');
const { join, resolve } = require('node:path');
const build = process.env.RAG_TEST_BUILD_DIR
  ? resolve(process.env.RAG_TEST_BUILD_DIR)
  : join(__dirname, '../dist');
const { AppModule } = require(join(build, 'app.module'));
const { EmbeddingsService } = require(join(build, 'modules/embeddings/embeddings.service'));
const { LlmService } = require(join(build, 'modules/llm/llm.service'));
let context;
(async () => {
  context = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmbeddingsService)
    .useValue({
      embedDocuments: async (texts) => texts.map(() => [1, ...Array(383).fill(0)]),
      embedQuery: async () => [1, ...Array(383).fill(0)],
    })
    .overrideProvider(LlmService)
    .useValue(agentLlmFixture({
      complete: async (prompt) =>
        prompt.startsWith('核查') ? '{"supported":true}' : '原文要求核对证据。[1]',
      stream: async function* () { yield '原文要求核对证据。[1]'; },
    }))
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
