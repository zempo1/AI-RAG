import { ConfigService } from '@nestjs/config';
import { pipeline } from './helpers/pipeline';
import { ModelSettingsService } from '../src/modules/model-settings/model-settings.service';
import { modelBinding, runWithModels } from '../src/modules/model-settings/model-runtime';
import { QaTasksService } from '../src/modules/tasks/qa-tasks.service';
import { AgentQaTasksService } from '../src/modules/tasks/agent-qa.service';
import { HistoryService } from '../src/modules/history/history.service';

const binding = (model: string) => ({ provider: 'openai-compatible' as const, baseUrl: 'https://fixture.invalid/v1', model, apiKey: 'account-secret', dimensions: 2, sendDimensions: false });

test('indexing freezes account configuration across worker retry and a manual reindex takes new settings', async () => {
  const p = await pipeline();
  try {
    const settings = new ModelSettingsService(p.store, p.config);
    await settings.save(1, 'embedding', binding('first-embedding'));
    const accepted = await runWithModels(await settings.resolveRuntime(1), () => p.documents.ingest(Buffer.from('测试原文'), 'a.md', 1));
    const raw = (await p.store.get('tasks', accepted.taskId))!;
    expect(typeof raw.payload?.modelSnapshot).toBe('string');
    expect(JSON.stringify(raw)).not.toContain('account-secret');
    expect(JSON.stringify(await p.tasks.get(accepted.taskId, 1))).not.toContain(raw.payload.modelSnapshot);
    await settings.save(1, 'embedding', binding('second-embedding'));
    p.beforeEmbedding(async () => { expect(modelBinding(p.config, 'embedding').model).toBe('first-embedding'); });
    p.setFailure(true);
    await expect(p.indexing.process(accepted.taskId, 3)).rejects.toThrow('embedding unavailable');
    p.setFailure(false);
    await p.tasks.retry(accepted.taskId, 1);
    await p.indexing.process(accepted.taskId);
    let doc = await p.documents.owned(accepted.documentId, 1);
    expect((await p.store.get('indexRevisions', doc.activeIndexRevisionId))?.modelProfile.model).toBe('first-embedding');
    const rebuilt = await runWithModels(await settings.resolveRuntime(1), () => p.documents.reindex(accepted.documentId, 1));
    p.beforeEmbedding(async () => { expect(modelBinding(p.config, 'embedding').model).toBe('second-embedding'); });
    await p.indexing.process(rebuilt.taskId);
    doc = await p.documents.owned(accepted.documentId, 1);
    expect((await p.store.get('indexRevisions', doc.activeIndexRevisionId))?.modelProfile.model).toBe('second-embedding');
    expect(doc.content).toBe('测试原文');
  } finally { await p.cleanup(); }
});

test('summary and Agent background jobs restore their captured model and hide snapshots in public task responses', async () => {
  const p = await pipeline();
  try {
    const settings = new ModelSettingsService(p.store, p.config);
    await settings.save(1, 'chat', binding('original-chat'));
    const snapshot = await settings.resolveRuntime(1), kb = await p.libraries.default(1);
    const chat = await p.store.save('chats', { userId: 1, knowledgeBaseId: kb.id });
    const summary = { summarize: async () => ({ answer: modelBinding(p.config, 'chat').model,
      citations: [], coverage: { complete: true }, diagnostics: {} }) };
    const qa = new QaTasksService(p.store, summary as any, p.config);
    const queued = await runWithModels(snapshot, () => qa.enqueue(1, chat.id, 'summary', 'hash', { userId: 1, knowledgeBaseId: kb.id, question: '总结' }));
    const agent = { prepare: async () => ({}), answerPrepared: async () => ({ answer: modelBinding(p.config, 'agent').model, citations: [] }) };
    const agents = new AgentQaTasksService(p.store, new HistoryService(p.store, p.libraries), p.libraries, agent as any, p.config);
    const started = await runWithModels(snapshot, () => agents.begin(1, { knowledgeBaseId: kb.id, question: '问答', requestId: 'agent', fingerprint: 'hash' }));
    expect(typeof started.task.payload.modelSnapshot).toBe('string');
    // Simulate a foreground owner dying before its first graph checkpoint.
    await p.store.save('tasks', { id: started.task.id, status: 'queued', executionToken: null,
      payload: { ...(await p.store.get('tasks', started.task.id))!.payload, foreground: false, leaseUntil: 0 } });
    await settings.save(1, 'chat', binding('changed-chat'));
    await qa.process(queued.taskId);
    await agents.process(started.task.id);
    const answers = (await p.store.list('messages')).filter(m => m.role === 'assistant');
    expect(answers.map(m => m.content)).toEqual(['original-chat', 'original-chat']);
    for (const id of [queued.taskId, started.task.id]) {
      const raw = (await p.store.get('tasks', id))!;
      expect(JSON.stringify(raw)).not.toContain('account-secret');
      expect(JSON.stringify(await p.tasks.get(id, 1))).not.toContain('modelSnapshot');
    }
  } finally { await p.cleanup(); }
});
