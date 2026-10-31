import { pipeline } from './helpers/pipeline';
import { TaskQueueRuntime } from '../src/modules/tasks/task-queue.runtime';

it('dispatches an already committed task without relying on the upload request and does not duplicate published chunks', async () => {
  const p = await pipeline();
  const uploaded = await p.documents.ingest(Buffer.from('持久任务'), 'a.md', 1);
  const runtime = new TaskQueueRuntime(p.config, p.store, p.indexing, p.tasks);
  try {
    await runtime.dispatch();
    expect((await p.tasks.get(uploaded.taskId, 1)).status).toBe('completed');
    await runtime.dispatch();
    expect(await p.store.list('chunks')).toHaveLength(1);
  } finally {
    await runtime.onModuleDestroy();
    await p.cleanup();
  }
});
