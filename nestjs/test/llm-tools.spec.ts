import { createServer, Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../src/modules/llm/llm.service';

let server: Server, llm: any, body: any, fail = false, stall = false, calls = 0;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    calls++;
    let raw = ''; for await (const part of req) raw += part;
    body = JSON.parse(raw);
    if (stall) return;
    if (fail) { res.writeHead(503); res.end('{"error":{"message":"unavailable"}}'); return; }
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: body.tools ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'keyword_search', arguments: '{"query":"TS-999"}' } }] } : { role: 'assistant', content: 'answer' }, finish_reason: body.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  llm = new LlmService(new ConfigService({ CHAT_API_KEY: 'fixture', CHAT_MODEL: 'test', CHAT_BASE_URL: 'http://127.0.0.1:' + (server.address() as any).port + '/v1' }));
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
const tools = [{ type: 'function', function: { name: 'keyword_search', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } }];

it('accepts empty content with valid tool calls and preserves tool reply IDs and usage', async () => {
  expect(typeof llm.invokeTools).toBe('function');
  const result = await llm.invokeTools([{ role: 'user', content: 'find' }, { role: 'assistant', content: '', tool_calls: [{ id: 'previous', type: 'function', function: { name: 'keyword_search', arguments: '{"query":"old"}' } }] }, { role: 'tool', tool_call_id: 'previous', content: 'old result' }], tools, { model: 'agent-model' });
  expect(result.content).toBe('');
  expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'keyword_search', args: { query: 'TS-999' } }]);
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  expect(body.model).toBe('agent-model');
  expect(body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'previous' });
});

it('awaits a reservation checkpoint before HTTP and settles successful complete with measured usage', async () => {
  const events: any[] = [];
  const previous = calls;
  const observer = {
    before: async (request: any) => { await Promise.resolve(); expect(calls).toBe(previous); events.push(request); return 'reservation-1'; },
    settle: async (id: string, outcome: any) => { events.push({ id, ...outcome }); },
  };
  expect(await llm.complete('find', undefined, [], undefined, { observer })).toBe('answer');
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ id: 'reservation-1', status: 'success', usage: { totalTokens: 12 } });
});

it('settles provider failures and prevents calls when budget or cancellation rejects reservation', async () => {
  const settled: any[] = [];
  fail = true;
  try {
    await expect(llm.complete('find', undefined, [], undefined, { observer: { before: async () => 'r', settle: async (...args: any[]) => { settled.push(args); } } })).rejects.toThrow();
  } finally { fail = false; }
  expect(settled[0]).toMatchObject(['r', { status: 'error' }]);
  const previous = calls;
  await expect(llm.complete('find', undefined, [], undefined, { observer: { before: async () => { throw new Error('budget exhausted'); }, settle: async () => {} } })).rejects.toThrow('budget exhausted');
  expect(calls).toBe(previous);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await expect(llm.invokeTools([{ role: 'user', content: 'find' }], tools, { signal: controller.signal })).rejects.toThrow();
  expect(calls).toBe(previous);
});

it('reserves and sends the per-call output limit for agent decisions', async () => {
  let reserved: any;
  const messages = [{ role: 'user', content: 'find' }];
  await llm.invokeTools(messages, tools, { maxOutputTokens: 1024, timeoutMs: 20000, observer: { before: async (request: any) => { reserved = request; return 'limit'; }, settle: async () => {} } });
  expect(body.max_tokens ?? body.max_completion_tokens).toBe(1024);
  expect(reserved.maxOutputTokens).toBe(1024);
  expect(reserved.input).toEqual({ messages, tools });
});

it('keeps independent reservations when two calls share an observer', async () => {
  let sequence = 0;
  const settled: string[] = [];
  const observer = { before: async () => 'concurrent-' + (++sequence), settle: async (id: string) => { settled.push(id); } };
  await Promise.all([llm.complete('a', undefined, [], undefined, { observer }), llm.complete('b', undefined, [], undefined, { observer })]);
  expect(settled.sort()).toEqual(['concurrent-1', 'concurrent-2']);
});

it.each(['complete', 'stream'])('sends the same output reservation and provider limit for %s', async kind => {
  let reserved: any;
  const options = { maxOutputTokens: 128, observer: { before: async (request: any) => { reserved = request; return 'limit'; }, settle: async () => {} } };
  if (kind === 'complete') await llm.complete('find', undefined, [], undefined, options);
  else for await (const _ of llm.stream('find', undefined, undefined, [], options)) {}
  expect(body.max_tokens ?? body.max_completion_tokens).toBe(128);
  expect(reserved.maxOutputTokens).toBe(128);
});

it.each(['complete', 'stream', 'tools'])('enforces the per-call timeout and settles %s failures', async kind => {
  const outcomes: any[] = [];
  const options = { timeoutMs: 40, signal: AbortSignal.timeout(1000), observer: { before: async () => 'timeout', settle: async (_: string, outcome: any) => { outcomes.push(outcome); } } };
  stall = true;
  const started = Date.now();
  try {
    const pending = kind === 'complete' ? llm.complete('find', undefined, [], undefined, options) : kind === 'tools' ? llm.invokeTools([{ role: 'user', content: 'find' }], tools, options) : (async () => { for await (const _ of llm.stream('find', undefined, undefined, [], options)) {} })();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(800);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('error');
  } finally { stall = false; }
});

it('propagates failed durable settlement instead of publishing the provider answer', async () => {
  await expect(llm.complete('find', undefined, [], undefined, { observer: { before: async () => 'checkpoint', settle: async () => { throw new Error('checkpoint failed'); } } })).rejects.toThrow('checkpoint failed');
});
