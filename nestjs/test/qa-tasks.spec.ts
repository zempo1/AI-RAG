import { MemoryStore } from '../src/persistence/memory.store';
import { QaTasksService } from '../src/modules/tasks/qa-tasks.service';
import { ConfigService } from '@nestjs/config';

it('queues a durable snapshot idempotently and publishes one answer across retries', async () => {
  const store = new MemoryStore();
  const kb = await store.save('knowledgeBases', { userId: 1 });
  const chat = await store.save('chats', { userId: 1, knowledgeBaseId: kb.id });
  const summary = {
    summarize: async (s: any) => ({
      answer: '完整回答[1]',
      citations: s.sources,
      coverage: { complete: true },
      diagnostics: { runId: 9 },
    }),
  };
  const service = new QaTasksService(
    store,
    summary as any,
    new ConfigService({ JWT_SECRET: 'secret' }),
  );
  const snapshot: any = {
    userId: 1,
    knowledgeBaseId: kb.id,
    chatId: chat.id,
    question: '总结',
    sources: [{ number: 1, text: '原文' }],
    revisions: [1],
    history: [],
    diagnostics: { runId: 9 },
  };
  const accepted = await service.enqueue(1, chat.id, 'request-1', 'hash', snapshot, 'private-key');
  expect((await service.enqueue(1, chat.id, 'request-1', 'hash', snapshot)).taskId).toBe(
    accepted.taskId,
  );
  await expect(service.lookup(1, 'request-1', 'other-hash')).rejects.toThrow('不同');
  expect(JSON.stringify(await store.get('tasks', accepted.taskId))).not.toContain('private-key');
  await service.process(accepted.taskId, 1);
  await service.process(accepted.taskId, 1);
  expect(
    (await store.list('messages', { chatId: chat.id })).filter((m) => m.role === 'assistant'),
  ).toHaveLength(1);
  expect((await store.get('tasks', accepted.taskId))?.status).toBe('completed');
});

it('recovers a crashed worker lease and retries failures without exposing the snapshot', async () => {
  const store = new MemoryStore();
  const kb = await store.save('knowledgeBases', { userId: 1 });
  const chat = await store.save('chats', { userId: 1, knowledgeBaseId: kb.id });
  let calls = 0;
  const summary = {
    summarize: async () => {
      if (++calls === 1) throw new Error('upstream secret error');
      return {
        answer: '恢复后的答案',
        citations: [],
        coverage: { complete: true },
        diagnostics: {},
      };
    },
  };
  const service = new QaTasksService(
    store,
    summary as any,
    new ConfigService({ JWT_SECRET: 'secret' }),
  );
  const task = await service.enqueue(
    1,
    chat.id,
    'recover',
    'hash',
    { userId: 1, knowledgeBaseId: kb.id, question: '总结', sources: [], diagnostics: {} },
    'key',
  );
  await store.save('tasks', {
    id: task.taskId,
    executionToken: 'dead-worker',
    status: 'running',
    payload: { ...(await store.get('tasks', task.taskId))!.payload, leaseUntil: Date.now() - 1 },
  });
  await expect(service.process(task.taskId, 1)).rejects.toThrow('总结服务暂不可用');
  expect((await store.get('tasks', task.taskId))!.error).not.toContain('secret');
  await service.process(task.taskId, 2);
  expect(
    (await store.list('messages', { chatId: chat.id })).filter((m) => m.role === 'assistant'),
  ).toHaveLength(1);
  expect((await store.get('tasks', task.taskId))!.status).toBe('completed');
});
