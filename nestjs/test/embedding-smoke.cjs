require('reflect-metadata');

const { ConfigService } = require('@nestjs/config');

const { validateConfig } = require('../dist/config/configuration');

const { EmbeddingsService } = require('../dist/embeddings/embeddings.service');

(async () => {
  const config = new ConfigService(
    validateConfig({
      ...process.env,
      STORAGE_DRIVER: 'memory',
      JWT_SECRET: 'embedding-smoke-only-secret-32-chars',
    }),
  );
  const service = new EmbeddingsService(config);
  try {
    const vectors = await service.embedDocuments([
      '知识库用于文档检索和回答问题',
      'A knowledge base supports retrieval and questions',
    ]);
    const query = await service.embedQuery('知识库用于文档检索和回答问题');
    if (vectors.length !== 2 || vectors.some((v) => v.length !== 384 || !v.every(Number.isFinite)))
      throw new Error('Invalid vectors');
    const cosine = vectors[0].reduce((s, x, i) => s + x * query[i], 0);
    if (cosine < 0.999) throw new Error('Inconsistent query/document vectors');
    console.log(
      JSON.stringify({
        model: config.get('EMBEDDING_MODEL'),
        dimensions: query.length,
        sameTextCosine: cosine,
      }),
    );
  } finally {
    await service.onModuleDestroy();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
