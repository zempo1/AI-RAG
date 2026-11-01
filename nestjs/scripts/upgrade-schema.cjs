require('dotenv/config');
const source = require('../dist/persistence/data-source').default;
const {
  DocumentCascade1793376000000,
} = require('../dist/persistence/migrations/1793376000000-document-cascade');
(async () => {
  await source.initialize();
  const runner = source.createQueryRunner();
  try {
    await new DocumentCascade1793376000000().up(runner);
    const {
      KnowledgeBases1793404800000,
    } = require('../dist/persistence/migrations/1793404800000-knowledge-bases');
    await new KnowledgeBases1793404800000().up(runner);
    const {
      RagQuality1793491200000,
    } = require('../dist/persistence/migrations/1793491200000-rag-quality');
    await new RagQuality1793491200000().up(runner);
    console.log('知识库、版本、任务与引用结构升级完成；旧文档归入用户默认库，旧页码保持未知。');
  } finally {
    await runner.release();
    await source.destroy();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
