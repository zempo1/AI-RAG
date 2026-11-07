import { ConfigService } from '@nestjs/config';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { PdfAnalysisClient } from '../src/modules/documents/parsers/pdf-analysis.client';

describe('internal PDF analysis client', () => {
  let server: Server;
  let client: PdfAnalysisClient;
  let response: unknown;
  let status: number;
  let requests: { url: string; body: string }[];
  beforeEach(async () => {
    requests = [];
    status = 200;
    response = { ready: true, manifest: 'layout-a+ocr-a' };
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      requests.push({ url: req.url!, body: Buffer.concat(chunks).toString() });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    client = new PdfAnalysisClient(
      new ConfigService({
        PDF_ANALYSIS_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    );
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  it('rejects unavailable models before a caller uses the manifest', async () => {
    response = { ready: false, manifest: 'loading' };
    await expect(client.health()).rejects.toThrow(/未就绪/);
  });
  it('refreshes health so a restarted service cannot reuse an old model cache', async () => {
    expect((await client.health()).manifest).toBe('layout-a+ocr-a');
    response = { ready: true, manifest: 'layout-b+ocr-b' };
    expect((await client.health()).manifest).toBe('layout-b+ocr-b');
  });
  it('uploads binary image and precision as multipart form fields', async () => {
    response = {
      regions: [{ kind: 'figure', bbox: [0.1, 0.2, 0.6, 0.7], score: 0.9 }],
      manifest: 'a',
    };
    expect((await client.layout(Buffer.from('image bytes'), 'high')).regions[0].kind).toBe(
      'figure',
    );
    expect(requests[0].url).toBe('/v1/layout');
    expect(requests[0].body).toContain('name="precision"');
    expect(requests[0].body).toContain('high');
    expect(requests[0].body).toContain('image bytes');
  });
  it.each([
    { kind: 'figure', bbox: [0, 0, 1.2, 1], score: 0.9 },
    { kind: 'figure', bbox: [0.8, 0, 0.2, 1], score: 0.9 },
    { kind: 'figure', bbox: [0, 0, 1, 1], score: null },
    { kind: 'unexpected', bbox: [0, 0, 1, 1], score: 0.9 },
  ])('rejects malformed geometry and scores: %j', async (region) => {
    response = { regions: [region], manifest: 'a' };
    await expect(client.layout(Buffer.from('x'), 'standard')).rejects.toThrow(/响应格式/);
  });
  it('validates OCR blocks and never falls back on service errors', async () => {
    response = { blocks: [{ text: '可检索文字', bbox: [0, 0, 1, 1], score: 0.98 }], manifest: 'a' };
    expect((await client.ocr(Buffer.from('x'))).blocks[0].text).toBe('可检索文字');
    status = 503;
    response = { detail: 'model failure' };
    await expect(client.ocr(Buffer.from('x'))).rejects.toThrow(/503/);
  });
  it('preserves the original cancellation reason', async () => {
    const abort = new AbortController();
    const reason = new Error('document deleted');
    abort.abort(reason);
    await expect(client.health(abort.signal)).rejects.toBe(reason);
  });

  it('serializes local inference across clients and cancels queued work without sending it', async () => {
    let active = 0, peak = 0, sent = 0;
    let entered!: () => void, release!: () => void;
    const firstEntered = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    server.removeAllListeners('request');
    server.on('request', async (req, res) => {
      for await (const _ of req) { /* consume multipart */ }
      sent++; active++; peak = Math.max(peak, active); entered();
      await gate;
      active--;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/v1/ocr' ? { blocks: [], manifest: 'a' } : { regions: [], manifest: 'a' }));
    });
    const other = new PdfAnalysisClient(new ConfigService({ PDF_ANALYSIS_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    const first = client.ocr(Buffer.from('x'));
    await firstEntered;
    const abort = new AbortController(), reason = new Error('superseded');
    const queued = other.ocr(Buffer.from('x'), abort.signal);
    const canceled = expect(queued).rejects.toBe(reason);
    abort.abort(reason);
    await canceled;
    const second = other.layout(Buffer.from('y'), 'standard');
    await new Promise(r => setTimeout(r, 25));
    release();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
    expect(sent).toBe(2);
  });
});
