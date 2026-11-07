import { EventEmitter } from 'node:events';
import { ChatService } from '../src/modules/chat/chat.service';
import { ChatController } from '../src/modules/chat/chat.controller';

it('routes prepared Agent contexts and both answer forms through the same Agent finalizer', async () => {
  const context = { engine: 'agentic-v1', sources: [], prompt: 'test' };
  let completed = 0, streamed = 0, baseline = 0;
  const agent: any = { prepare: async () => context,
    answerPrepared: async () => { completed++; return { answer: 'Agent答案', citations: [] }; },
    streamPrepared: async function* () { streamed++; yield { type: 'message', text: 'Agent答案' }; yield { type: 'done', answer: 'Agent答案', citations: [] }; },
  };
  const llm: any = { complete: async () => { baseline++; return '固定答案'; } };
  const service = new ChatService(agent, llm);
  expect((await service.answerPrepared(await service.prepare('问题', 1))).answer).toBe('Agent答案');
  const events = [];
  for await (const event of service.streamPrepared(context)) events.push(event);
  expect(events.at(-1)?.answer).toBe('Agent答案');
  expect(completed).toBe(1);
  expect(streamed).toBe(1);
  expect(baseline).toBe(0);
});

it('binds SSE disconnection before preparation and aborts retrieval without starting generation', async () => {
  const res: any = new EventEmitter();
  res.status = () => res; res.set = () => res; res.flushHeaders = () => {};
  res.write = () => true; res.end = () => { res.writableEnded = true; };
  res.destroyed = false; res.writableEnded = false;
  let signal: AbortSignal | undefined, generation = 0;
  const chat: any = {
    prepare: async (_q: string, _u: number, _kb: number, options: any) => {
      signal = options.signal;
      res.destroyed = true; res.emit('close');
      signal?.throwIfAborted();
      return { sources: [], directAnswer: '不应生成' };
    },
    streamPrepared: async function* () { generation++; yield { type: 'done', answer: '错误', citations: [] }; },
  };
  const history: any = { create: async () => ({ id: 1, knowledgeBaseId: 1, messages: [] }), addMessage: async () => {} };
  const controller = new ChatController(chat, history, { lookup: async () => null } as any);
  await controller.stream({ question: '问题', knowledgeBaseId: 1 }, 1, undefined, res);
  expect(signal).toBeDefined();
  expect(signal?.aborted).toBe(true);
  expect(generation).toBe(0);
});
