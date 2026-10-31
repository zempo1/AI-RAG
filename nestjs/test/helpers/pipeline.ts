import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { validateConfig } from '../../src/config/configuration';
import { MemoryStore } from '../../src/persistence/memory.store';
import { KnowledgeBasesService } from '../../src/modules/knowledge-bases/knowledge-bases.service';
import { TasksService } from '../../src/modules/tasks/tasks.service';
import { DocumentsService } from '../../src/modules/documents/documents.service';
import { IndexingService } from '../../src/modules/documents/indexing.service';
import { DocumentParser } from '../../src/modules/documents/parsers/document.parser';
import { RecursiveChunker } from '../../src/modules/documents/chunkers/recursive.chunker';
import { InMemoryVectorStore } from '../../src/modules/vector-store/in-memory-vector-store.service';

export async function pipeline() {
  const directory = await mkdtemp(join(tmpdir(), 'rag-pipeline-'));
  const config = new ConfigService(
    validateConfig({
      STORAGE_DRIVER: 'memory',
      JWT_SECRET: 'x'.repeat(32),
      ORIGINALS_DIR: directory,
      INDEX_RETENTION_MS: 0,
    }),
  );
  const store = new MemoryStore();
  const libraries = new KnowledgeBasesService(store);
  const tasks = new TasksService(store, libraries);
  const vectors = new InMemoryVectorStore();
  let fail = false;
  let beforeEmbedding: (() => Promise<void>) | undefined;
  const embeddings = {
    embedDocuments: async (texts: string[]) => {
      await beforeEmbedding?.();
      if (fail) throw new Error('embedding unavailable');
      return texts.map(() => [1, 0]);
    },
    embedQuery: async () => [1, 0],
  };
  const documents = new DocumentsService(store, new DocumentParser(), libraries, tasks, config);
  const indexing = new IndexingService(
    store,
    new DocumentParser(),
    new RecursiveChunker(),
    embeddings as any,
    vectors,
    tasks,
    config,
  );
  return {
    store,
    libraries,
    tasks,
    documents,
    indexing,
    vectors,
    config,
    embeddings,
    setFailure: (value: boolean) => {
      fail = value;
    },
    beforeEmbedding: (callback: () => Promise<void>) => {
      beforeEmbedding = callback;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
