import { createServer, Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../src/modules/llm/llm.service';

let server: Server, base: string, payload: any, reason = 'stop', content = '完整答案';
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    payload = JSON.parse(raw);
    res.setHeader('Content-Type', 'text/event-stream');
    for (const delta of [{ content }, {}]) res.write('data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: delta.content === undefined ? reason : null }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as any).port + '/v1';
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
it('disables hidden thinking and returns a complete streamed answer', async () => {
  const llm = new LlmService(new ConfigService({ CHAT_MODEL: 'qwen3.8-flash', CHAT_BASE_URL: base, CHAT_API_KEY: 'fixture' }));
  let text = ''; for await (const token of llm.stream('问题')) text += token;
  expect(text).toBe('完整答案'); expect(payload.enable_thinking).toBe(false);
});
it('reports output limits rather than accepting truncated answers as complete', async () => {
  reason = 'length';
  const llm = new LlmService(new ConfigService({ CHAT_MODEL: 'qwen3.8-flash', CHAT_BASE_URL: base, CHAT_API_KEY: 'fixture' }));
  await expect((async () => { for await (const token of llm.stream('问题')) {} })()).rejects.toThrow('输出长度上限');
});
