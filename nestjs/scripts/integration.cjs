const { spawnSync } = require('node:child_process');
const path = require('node:path');
// Never inherit DB_NAME or credentials pointing at the user's business database.
const result = spawnSync(
  process.execPath,
  [
    '--experimental-vm-modules',
    path.resolve('node_modules/jest/bin/jest.js'),
    '--config',
    'test/jest-e2e.json',
    '--runInBand',
    '--runTestsByPath',
    'test/mysql.e2e-spec.ts',
    'test/pipeline.e2e-spec.ts',
  ],
  {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      MYSQL_INTEGRATION: '1',
      RAG_INTEGRATION: '1',
      DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
      DB_PORT: process.env.TEST_DB_PORT || '13306',
      DB_USER: 'root',
      DB_PASSWORD: process.env.TEST_DB_PASSWORD || 'rag-test-only',
      DB_NAME: 'unused_test_placeholder',
      JWT_SECRET: 'integration-test-secret-32-characters',
      QDRANT_URL: process.env.TEST_QDRANT_URL || 'http://127.0.0.1:16333',
      REDIS_URL: process.env.TEST_REDIS_URL || 'redis://127.0.0.1:16379',
      TEST_REDIS_RESTART:
        process.env.TEST_REDIS_RESTART || (!process.env.TEST_REDIS_URL ? '1' : '0'),
      ORIGINALS_DIR: '.tmp/mysql-integration/originals',
      INDEX_RETENTION_MS: '0',
    },
  },
);
process.exitCode = result.status ?? 1;
