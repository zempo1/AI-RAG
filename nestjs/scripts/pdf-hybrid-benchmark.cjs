// Default: local parsing + simulated vision. --live permits at most 12 paid requests overall.
require('dotenv/config');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
require('@nestjs/common').Logger.overrideLogger(['error', 'warn']);
const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
(async () => {
  const file = arg('--file');
  if (!file) throw Error('--file <PDF> required; optional --pages 39,74 --mock-local --live');
  const build = path.resolve(arg('--build-dir', 'dist'));
  const { PdfVisualService } = require(path.join(build, 'modules/documents/parsers/pdf-visual.service'));
  const { PageAssetsService } = require(path.join(build, 'modules/documents/page-assets.service'));
  const { MemoryStore } = require(path.join(build, 'persistence/memory.store'));
  const { LlmService } = require(path.join(build, 'modules/llm/llm.service'));
  const { validateConfig } = require(path.join(build, 'config/configuration'));
  const { localRendering } = require(path.join(build, 'modules/documents/parsers/vision-scheduler'));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = new Uint8Array(await fs.readFile(file));
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const root = path.resolve(arg('--output', '.data/adaptive-pdf-benchmark/' + Date.now()));
  await fs.mkdir(root, { recursive: true });
  const live = process.argv.includes('--live'), mockLocal = process.argv.includes('--mock-local');
  if (live && mockLocal) throw Error('--live and --mock-local cannot be combined');
  const report = { file: path.basename(file), live, mockLocal, maxLiveRequests: 12, requests: 0, usage: [], localRequests: [], runs: [] };
  let phase;
  const originalFetch = global.fetch;
  // Usage only; do not store API keys, prompts, response text or images in the report.
  global.fetch = async (...args) => {
    const started = performance.now();
    const url = String(args[0]);
    const local = /\/(health|v1\/(?:layout|ocr))$/.exec(url)?.[1];
    const manifest = 'benchmark-mock-local-v1';
    const response = mockLocal && local
      ? Response.json(local === 'health' ? { ready: true, manifest }
        : local === 'v1/layout' ? { regions: [], manifest }
        : { blocks: [], textOnly: false, manifest })
      : await originalFetch(...args);
    if (local)
      report.localRequests.push({ ...phase, kind: local, status: response.status, elapsedMs: performance.now() - started });
    if (String(args[0]).includes('/chat/completions') && response.ok) {
      const body = await response.clone().json();
      report.usage.push(body.usage || null);
    }
    return response;
  };
  try {
    {
      const config = new ConfigService(validateConfig({ ...process.env, STORAGE_DRIVER: 'memory', VECTOR_DRIVER: 'memory', QUEUE_DRIVER: 'memory', PAGE_ASSETS_DIR: path.join(root, 'pages') }));
      const real = report.live ? new LlmService(config) : undefined;
      let requests = 0, peak = 0, active = 0, imagePixels = 0, imageBytes = 0;
      const llm = { complete: async (...args) => {
        if (real && report.requests >= 12) throw Error('Reached benchmark limit of 12 paid requests');
        report.requests++; requests++; active++; peak = Math.max(peak, active);
        for (const image of args[2] || []) {
          const bytes = Buffer.from(image.dataUrl.split(',')[1], 'base64');
          imageBytes += bytes.length;
          if (bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG')
            imagePixels += bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
        }
        try {
          if (real) return await real.complete(...args);
          await new Promise(resolve => setTimeout(resolve, Number(arg('--delay-ms', '100'))));
          return JSON.stringify({ blocks: [{ type: 'figure', text: '模拟图表描述，仅用于测速' }] });
        } finally { active--; }
      } };
      const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0 });
      const doc = await task.promise;
      const pages = arg('--pages') ? [...new Set(arg('--pages').split(',').map(Number))] : Array.from({ length: doc.numPages }, (_, i) => i + 1);
      if (pages.some(n => !Number.isInteger(n) || n < 1 || n > doc.numPages)) throw Error('Invalid page');
      const service = new PdfVisualService(config, llm, new PageAssetsService(config, new MemoryStore()));
      try {
        for (const pass of ['cold', 'cached']) {
          phase = { pass };
          const before = requests, beforePixels = imagePixels, beforeBytes = imageBytes, started = performance.now(), rows = [];
          peak = 0;
          let next = 0, failure, peakRssBytes = process.memoryUsage().rss;
          const sample = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 20);
          const controller = new AbortController();
          const scope = { userId: 1, documentId: 1, versionId: 1, sourceHash, signal: controller.signal,
            beforeRequest: () => { if (failure) throw failure; } };
          try {
            await Promise.all(Array.from({ length: Math.min(service.concurrency, pages.length) }, async () => {
              while (next < pages.length && !failure) {
                const index = next++, n = pages[index];
                let page;
                try {
                  page = await doc.getPage(n);
                  const content = await localRendering.run(() => page.getTextContent());
                  const result = await service.page(doc, page, content.items.map(i => i.str || '').join('\n'), scope, content);
                  rows[index] = { page: n, blocks: result.blocks.length, ...result.stats };
                } catch (error) { failure ||= error; }
                finally { if (page) page.cleanup(); }
              }
            }));
          } finally { clearInterval(sample); }
          report.runs.push({ pass, pipeline: 'bounded-parallel-pages', elapsedMs: performance.now() - started,
            requests: requests - before, imagePixels: imagePixels - beforePixels, imageBytes: imageBytes - beforeBytes,
            peak, peakRssBytes: Math.max(peakRssBytes, process.memoryUsage().rss), pages: rows.filter(Boolean),
            ...(failure ? { error: failure.message } : {}) });
          if (failure) throw failure;
        }
      } finally { await task.destroy(); }
    }
  } finally {
    global.fetch = originalFetch;
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(path.join(root, 'report.json'));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
