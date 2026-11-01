import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { RagService } from '../src/modules/rag/rag.service';
import { ChatService } from '../src/modules/chat/chat.service';
const make = () => {
 const store = { save: async (_table: string, row: any) => ({ ...row, id: 1 }), list: jest.fn(async () => []) };
 const rag = new RagService({} as any, {} as any, store as any, { resolve: async () => ({ id: 1 }) } as any, undefined, undefined, new ConfigService({ STORAGE_DRIVER: 'memory' }));
 return { rag, store };
};
it('answers greetings without accessing document chunks or models', async () => {
 const { rag, store } = make();
 const result = await rag.prepare('你好！', 1, 1);
 expect(result.directAnswer).toContain('你好'); expect(store.list).not.toHaveBeenCalled();
});
it('generates a general answer with no retrieved sources', async () => {
 const { rag, store } = make();
 const llm = { complete: jest.fn(async () => '通用答案'), stream: async function* () { yield '通用答案'; } };
 const chat = new ChatService(rag, llm as any);
 const ctx = await rag.prepare('解释Vue响应式', 1, 1, { mode: 'general' });
 expect(store.list).not.toHaveBeenCalled();
 expect((await chat.answerPrepared(ctx)).answer).toBe('通用答案');
 const events = []; for await (const e of chat.streamPrepared(ctx)) events.push(e);
 expect(events.some(e => e.type === 'message' && e.text === '通用答案')).toBe(true);
});
it('does not mistake a greeting followed by a document request for small talk', async () => {
 const { rag, store } = make();
 await rag.prepare('你好，分析这份文档', 1, 1);
 expect(store.list).toHaveBeenCalled();
});

it('routes an unrelated question through the planner without retrieving vectors', async () => {
 const embedQuery = jest.fn();
 const rag = new RagService({ embedQuery } as any, {} as any,
   { list: async () => [] } as any, { resolve: async () => ({ id: 1 }) } as any,
   undefined, { plan: async () => ({ route: 'general', query: '什么是Vue', mode: 'search', keywords: [], documentIds: [], ambiguous: false }) } as any,
   new ConfigService({ STORAGE_DRIVER: 'mysql' }));
 const result = await rag.prepare('什么是Vue', 1, 1);
 expect(result.diagnostics.responseType).toBe('general');
 expect(embedQuery).not.toHaveBeenCalled();
});
