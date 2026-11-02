import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../src/modules/llm/llm.service';

describe('real LangChain HTTP adapter against a local OpenAI-compatible server', () => {
  let server: Server;
  let llm: LlmService;
  let received: { auth?: string; body?: any };
  let failure = false;
  let stall = false;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const buffers: Buffer[] = [];
      for await (const b of req) buffers.push(b);
      received = {
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(buffers).toString()),
      };
      if (stall) return;
      if (failure) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'provider unavailable', type: 'server_error', code: 'unavailable' },
          }),
        );
        return;
      }
      if (received.body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const content of ['中文', '答案'])
          res.write(
            `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`,
          );
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'mock',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '模型答案' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    llm = new LlmService(
      new ConfigService({
        CHAT_API_KEY: 'server-key',
        CHAT_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        CHAT_MODEL: 'test-model',
      }),
    );
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('sends the original prompt and configured model with request-scoped key overrides', async () => {
    expect(await llm.complete('原始问题', 'request-key')).toBe('模型答案');
    expect(received.auth).toBe('Bearer request-key');
    expect(received.body.model).toBe('test-model');
    expect(received.body.messages).toEqual([{ role: 'user', content: '原始问题' }]);
    await llm.complete('再次提问');
    expect(received.auth).toBe('Bearer server-key');
  });
  it('decodes OpenAI streaming tokens without modifying content', async () => {
    const tokens: string[] = [];
    for await (const token of llm.stream('问题')) tokens.push(token);
    expect(tokens).toEqual(['中文', '答案']);
    expect(received.body.stream).toBe(true);
  });
  it('sends labelled page images using the independently configured vision model and key', async () => {
    const vision = new LlmService(new ConfigService({
      CHAT_API_KEY: 'text-key', CHAT_MODEL: 'text-model',
      CHAT_BASE_URL: 'http://127.0.0.1:1/v1',
      VISION_API_KEY: 'vision-key', VISION_MODEL: 'qwen3.8-flash',
      VISION_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    }));
    const images = [{ dataUrl: 'data:image/png;base64,aGVsbG8=', label: '[1] 第2页' }];
    expect(await (vision.complete as any)('检查原图', undefined, images)).toBe('模型答案');
    expect(received.auth).toBe('Bearer vision-key');
    expect(received.body.model).toBe('qwen3.8-flash');
    expect(received.body.messages[0].content).toContainEqual({
      type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' },
    });
    const tokens: string[] = [];
    for await (const token of (vision.stream as any)('检查原图', undefined, undefined, images)) tokens.push(token);
    expect(tokens.join('')).toBe('中文答案');
    expect(received.body.model).toBe('qwen3.8-flash');
  });
  it('surfaces provider failures and missing keys', async () => {
    failure = true;
    await expect(llm.complete('失败')).rejects.toThrow('provider unavailable');
    failure = false;
    const missing = new LlmService(new ConfigService({}));
    await expect(missing.complete('问题')).rejects.toThrow('CHAT_API_KEY');
  });
  it('bounds vision requests with the configured timeout', async () => {
    stall = true;
    try {
      const bounded = new LlmService(new ConfigService({ VISION_API_KEY: 'test',
        VISION_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, VISION_TIMEOUT_MS: 50 }));
      const started = Date.now();
      await expect(bounded.complete('检查原图', undefined, [{ label: '第1页', dataUrl: 'data:image/png;base64,aA==' }]))
        .rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally { stall = false; }
  });
});
