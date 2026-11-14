import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../src/modules/llm/llm.service';
import { AgentBudget } from '../src/modules/agent/agent-budget';

describe('stream recovery through the real SDK and controlled local transport', () => {
  let server: Server, url: string, llm: LlmService;
  const nativeFetch = globalThis.fetch;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      for await (const _ of req) { /* drain the complete request */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '本地答案' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    llm = new LlmService(new ConfigService({ CHAT_API_KEY: 'local-test', CHAT_MODEL: 'test', CHAT_BASE_URL: url }));
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  function connectTimeout() {
    return new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  }
  async function collect(signal?: AbortSignal, observer?: AgentBudget) {
    let answer = '';
    for await (const part of llm.stream('本地测试问题', undefined, signal, [], { observer, timeoutMs: 5000 })) answer += part;
    return answer;
  }
  it('recovers once before any body text and charges both attempts to the model budget', async () => {
    let attempts = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      if (++attempts === 1) throw connectTimeout();
      return nativeFetch(...args);
    });
    const state = AgentBudget.initial(), observer = new AgentBudget(state, async () => {}, true);
    expect(await collect(undefined, observer)).toBe('本地答案');
    expect(attempts).toBe(2);
    expect(state.calls).toBe(2);
    expect(state.reservations).toEqual({});
  });
  it('stops after the second timeout with an actionable Chinese message', async () => {
    let attempts = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { attempts++; throw connectTimeout(); });
    await expect(collect()).rejects.toThrow('模型服务连接超时');
    expect(attempts).toBe(2);
  });
  it('does not retry when the user cancels the first request', async () => {
    const abort = new AbortController();
    let attempts = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++; abort.abort(new Error('用户停止')); throw connectTimeout();
    });
    await expect(collect(abort.signal)).rejects.toThrow();
    expect(attempts).toBe(1);
  });
  it('never restarts a stream after body text has already been delivered', async () => {
    let transport: ReadableStreamDefaultController<Uint8Array>, attempts = 0;
    const body = new ReadableStream<Uint8Array>({ start(controller) { transport = controller; } });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++;
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const iterator = llm.stream('本地测试问题');
    const first = iterator.next();
    transport!.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ index: 0,
      delta: { role: 'assistant', content: '已生成内容' }, finish_reason: null }] }) + '\n\n'));
    expect((await first).value).toBe('已生成内容');
    transport!.error(Object.assign(new Error('Request timed out.'), { name: 'TimeoutError' }));
    await expect(iterator.next()).rejects.toThrow();
    expect(attempts).toBe(1);
  });
  it('does not retry authentication failures', async () => {
    let attempts = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { message: 'invalid credential' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } });
    });
    await expect(collect()).rejects.toThrow();
    expect(attempts).toBe(1);
  });
  it('does not bypass the model-call budget when retrying', async () => {
    let attempts = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { attempts++; throw connectTimeout(); });
    const state = AgentBudget.initial(), observer = new AgentBudget(state, async () => {}, true,
      undefined, undefined, { calls: 1, tokens: 100000, activeMs: 600000, finalReserve: 0 });
    await expect(collect(undefined, observer)).rejects.toThrow('预算');
    expect(attempts).toBe(1);
    expect(state.calls).toBe(1);
    expect(state.reservations).toEqual({});
  });
  it('cancels retry backoff before a second network request is sent', async () => {
    let attempts = 0;
    const abort = new AbortController();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++;
      setTimeout(() => abort.abort(new Error('用户停止')), 25);
      throw connectTimeout();
    });
    await expect(collect(abort.signal)).rejects.toThrow();
    expect(attempts).toBe(1);
  });
  it('keeps the original request deadline instead of resetting it for a retry', async () => {
    let attempts = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { attempts++; throw connectTimeout(); });
    const read = async () => {
      for await (const _ of llm.stream('本地测试', undefined, undefined, [], { timeoutMs: 20 })) { /* no content expected */ }
    };
    await expect(read()).rejects.toThrow('模型服务连接超时');
    expect(attempts).toBe(1);
  });
  it('does not send a retry when durable budget settlement and backoff cross the original deadline', async () => {
    await collect(); // Load the SDK before measuring this short controlled deadline.
    let attempts = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      if (++attempts === 1) throw connectTimeout();
      return nativeFetch(...args);
    });
    const state = AgentBudget.initial();
    const observer = new AgentBudget(state, async () => {
      if (state.calls === 1 && !Object.keys(state.reservations).length)
        await new Promise(resolve => setTimeout(resolve, 350));
    }, true);
    const read = async () => {
      for await (const _ of llm.stream('本地测试', undefined, undefined, [], { observer, timeoutMs: 500 })) { /* no content expected */ }
    };
    await expect(read()).rejects.toThrow('模型服务连接超时');
    expect(attempts).toBe(1);
    expect(state.calls).toBe(1);
  });
  it('does not send a request if the durable budget reservation itself consumes the remaining time', async () => {
    let attempts = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      attempts++; return nativeFetch(...args);
    });
    const state = AgentBudget.initial(), observer = new AgentBudget(state, async () => {
      if (Object.keys(state.reservations).length) await new Promise(resolve => setTimeout(resolve, 50));
    }, true);
    const read = async () => {
      for await (const _ of llm.stream('本地测试', undefined, undefined, [], { observer, timeoutMs: 20 })) { /* no content expected */ }
    };
    await expect(read()).rejects.toThrow('模型服务连接超时');
    expect(attempts).toBe(0);
    expect(state.reservations).toEqual({});
  });
});
