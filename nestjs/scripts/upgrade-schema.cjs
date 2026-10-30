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
    console.log('来源关联与级联删除结构升级完成；未按标题推测旧思维导图归属。');
  } finally {
    await runner.release();
    await source.destroy();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
