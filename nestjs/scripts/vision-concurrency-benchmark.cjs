require('dotenv/config');
const fs = require('node:fs/promises'),
  path = require('node:path');
const { ConfigService } = require('@nestjs/config');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
(async () => {
  if (!process.argv.includes('--live')) {
    console.log('加 --live --file <PDF> 后比较3个区域的串行/并发，最多6次真实视觉调用。');
    return;
  }
  const file = arg('--file');
  if (!file) throw Error('--file required');
  const build = path.resolve(arg('--build-dir', 'dist'));
  const { validateConfig } = require(path.join(build, 'config/configuration'));
  const { PdfVisualService } = require(
    path.join(build, 'modules/documents/parsers/pdf-visual.service'),
  );
  const { PageAssetsService } = require(path.join(build, 'modules/documents/page-assets.service'));
  const { LlmService } = require(path.join(build, 'modules/llm/llm.service'));
  const { MemoryStore } = require(path.join(build, 'persistence/memory.store'));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = await fs.readFile(file),
    root = path.resolve('.data/concurrency-benchmark/' + Date.now());
  await fs.mkdir(root, { recursive: true });
  const report = [];
  for (const concurrency of [1, 3]) {
    const config = new ConfigService(
      validateConfig({
        ...process.env,
        STORAGE_DRIVER: 'memory',
        VECTOR_DRIVER: 'memory',
        QUEUE_DRIVER: 'memory',
        VISION_CONCURRENCY: concurrency,
        PAGE_ASSETS_DIR: path.join(root, String(concurrency)),
      }),
    );
    const task = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        useSystemFonts: true,
        verbosity: 0,
      }),
      doc = await task.promise;
    const visual = new PdfVisualService(
      config,
      new LlmService(config),
      new PageAssetsService(config, new MemoryStore()),
    );
    const row = { concurrency, calls: 0, peak: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 };
    let active = 0;
    const originalFetch = global.fetch;
    global.fetch = async (...args) => {
      row.calls++;
      active++;
      row.peak = Math.max(row.peak, active);
      try {
        const res = await originalFetch(...args);
        if (res.ok) {
          const b = await res.clone().json();
          row.inputTokens += b.usage?.prompt_tokens || 0;
          row.outputTokens += b.usage?.completion_tokens || 0;
        }
        return res;
      } finally {
        active--;
      }
    };
    try {
      const started = Date.now();
      const results = await Promise.allSettled(
        [23, 26, 27].map(async (n) => {
          const page = await doc.getPage(n),
            content = await page.getTextContent();
          return visual.page(
            doc,
            page,
            content.items.map((x) => x.str || '').join(' '),
            { userId: 1, documentId: 1, versionId: 1 },
            content,
          );
        }),
      );
      row.elapsedMs = Date.now() - started;
      if (results.some((r) => r.status === 'rejected')) throw Error('部分识别失败，见模型日志');
      row.results = results.map((r) => r.value);
    } finally {
      global.fetch = originalFetch;
      await task.destroy();
    }
    report.push(row);
  }
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { report: path.join(root, 'report.json'), metrics: report.map(({ results, ...row }) => row) },
      null,
      2,
    ),
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
