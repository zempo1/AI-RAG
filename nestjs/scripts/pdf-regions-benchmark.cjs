// --live explicitly enables paid requests; without it this only measures local layout.
require('dotenv/config');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { ConfigService } = require('@nestjs/config');
const arg = (name, fallback) => {
  const n = process.argv.indexOf(name);
  return n < 0 ? fallback : process.argv[n + 1];
};

(async () => {
  const file = arg('--file');
  if (!file)
    throw new Error(
      'Usage: node scripts/pdf-regions-benchmark.cjs --file <PDF> [--pages 2,23] [--build-dir dist] [--live]',
    );
  const build = resolve(arg('--build-dir', 'dist'));
  const { locateRegions } = require(join(build, 'modules/documents/parsers/pdf-layout'));
  const { PdfVisualService, PDF_VISION_PROMPT } = require(
    join(build, 'modules/documents/parsers/pdf-visual.service'),
  );
  const { PageAssetsService } = require(join(build, 'modules/documents/page-assets.service'));
  const { LlmService } = require(join(build, 'modules/llm/llm.service'));
  const { MemoryStore } = require(join(build, 'persistence/memory.store'));
  const { validateConfig } = require(join(build, 'config/configuration'));
  const root = resolve(arg('--output', '.data/region-benchmark/run-' + Date.now()));
  await mkdir(root, { recursive: true });
  const config = new ConfigService(
    validateConfig({
      ...process.env,
      STORAGE_DRIVER: 'memory',
      VECTOR_DRIVER: 'memory',
      QUEUE_DRIVER: 'memory',
      PAGE_ASSETS_DIR: join(root, 'pages'),
    }),
  );
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(file)),
    useSystemFonts: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages = [...new Set(arg('--pages', '1').split(',').map(Number))];
  const report = { pages: [], requests: [] };
  const originalFetch = global.fetch;
  let mode = 'baseline';
  global.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (response.ok) {
      const body = await response.clone().json();
      report.requests.push({ mode, usage: body.usage });
    }
    return response;
  };
  try {
    const llm = new LlmService(config);
    const visual = new PdfVisualService(
      config,
      llm,
      new PageAssetsService(config, new MemoryStore()),
    );
    for (const number of pages) {
      if (!Number.isInteger(number) || number < 1 || number > doc.numPages)
        throw new Error('Invalid page');
      const page = await doc.getPage(number),
        content = await page.getTextContent();
      const native = content.items.map((x) => x.str || '').join(' ');
      const start = Date.now(),
        regions = await locateRegions(doc, page, native, content);
      const row = {
        page: number,
        layoutMs: Date.now() - start,
        regions,
        baselinePixels: 0,
        regionalPixels: 0,
        baselineMs: 0,
        regionalMs: 0,
      };
      const view = page.getViewport({ scale: 2 });
      row.baselinePixels = Math.ceil(view.width) * Math.ceil(view.height);
      row.regionalPixels = regions.reduce(
        (sum, r) =>
          sum +
          Math.ceil((r.bbox[2] - r.bbox[0]) * view.width) *
            Math.ceil((r.bbox[3] - r.bbox[1]) * view.height),
        0,
      );
      if (process.argv.includes('--live')) {
        mode = 'baseline';
        const t = Date.now();
        const canvas = doc.canvasFactory.create(Math.ceil(view.width), Math.ceil(view.height));
        let bytes;
        try {
          await page.render({
            canvas: canvas.canvas,
            canvasContext: canvas.context,
            viewport: view,
          }).promise;
          bytes = canvas.canvas.toBuffer('image/png');
        } finally {
          doc.canvasFactory.destroy(canvas);
        }
        await writeFile(join(root, `page-${number}-baseline.png`), bytes);
        row.baselineText = await llm.complete(
          PDF_VISION_PROMPT + '\n原生文字：\n' + native,
          undefined,
          [
            {
              label: `第${number}页`,
              dataUrl: 'data:image/png;base64,' + bytes.toString('base64'),
            },
          ],
        );
        row.baselineMs = Date.now() - t;
        mode = 'regions';
        const t2 = Date.now();
        row.result = await visual.page(
          doc,
          page,
          native,
          { userId: 1, documentId: 1, versionId: 1 },
          content,
        );
        row.regionalMs = Date.now() - t2 + row.layoutMs;
      }
      report.pages.push(row);
      page.cleanup();
    }
  } finally {
    global.fetch = originalFetch;
    await task.destroy();
  }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  const summarize = (mode) => {
    const calls = report.requests.filter((r) => r.mode === mode);
    return {
      calls: calls.length,
      inputTokens: calls.reduce((s, r) => s + (r.usage?.prompt_tokens || 0), 0),
      outputTokens: calls.reduce((s, r) => s + (r.usage?.completion_tokens || 0), 0),
      pixels: report.pages.reduce(
        (s, r) => s + (mode === 'baseline' ? r.baselinePixels : r.regionalPixels),
        0,
      ),
      elapsedMs: report.pages.reduce(
        (s, r) => s + (mode === 'baseline' ? r.baselineMs : r.regionalMs),
        0,
      ),
    };
  };
  console.log(
    JSON.stringify(
      {
        report: join(root, 'report.json'),
        live: process.argv.includes('--live'),
        pages: report.pages.map((p) => ({ page: p.page, regions: p.regions.length })),
        baseline: summarize('baseline'),
        regions: summarize('regions'),
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
