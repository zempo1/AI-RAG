// Explicitly opt in to paid vision calls: npm run test:vision -- --live
require('dotenv/config');
const { ConfigService } = require('@nestjs/config');
const { createCanvas } = require('@napi-rs/canvas');
const PDFDocument = require('pdfkit');
const { mkdir, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { validateConfig } = require('../dist/config/configuration');
const { MemoryStore } = require('../dist/persistence/memory.store');
const { LlmService } = require('../dist/modules/llm/llm.service');
const { PageAssetsService } = require('../dist/modules/documents/page-assets.service');
const { PdfVisualService } = require('../dist/modules/documents/parsers/pdf-visual.service');
const { DocumentParser } = require('../dist/modules/documents/parsers/document.parser');

(async () => {
  if (!process.argv.includes('--live')) {
    console.log(
      '未调用模型。加 --live 后会生成一页测试 PDF 并发送至配置的视觉 API，产生按量费用。',
    );
    return;
  }
  const scan = process.argv.includes('--scan');
  const root = resolve(scan ? '.data/vision-smoke-scan' : '.data/vision-smoke');
  const config = new ConfigService(
    validateConfig({
      ...process.env,
      STORAGE_DRIVER: 'memory',
      VECTOR_DRIVER: 'memory',
      QUEUE_DRIVER: 'memory',
      VISION_ENABLED: true,
      PAGE_ASSETS_DIR: join(root, 'pages'),
    }),
  );
  const canvas = createCanvas(900, 520),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 900, 520);
  ctx.fillStyle = 'black';
  ctx.font = '32px sans-serif';
  ctx.fillText('IMAGE-CODE-42', 40, 55);
  ctx.font = '26px sans-serif';
  for (const [text, x, y] of [
    ['Metric', 55, 115],
    ['Value', 300, 115],
    ['Alpha', 55, 170],
    ['42', 300, 170],
    ['Beta', 55, 225],
    ['18', 300, 225],
    ['Q1', 570, 470],
    ['Q2', 720, 470],
    ['10', 570, 310],
    ['20', 720, 210],
  ])
    ctx.fillText(text, x, y);
  ctx.lineWidth = 2;
  for (const y of [80, 135, 190, 245]) {
    ctx.beginPath();
    ctx.moveTo(35, y);
    ctx.lineTo(430, y);
    ctx.stroke();
  }
  for (const x of [35, 270, 430]) {
    ctx.beginPath();
    ctx.moveTo(x, 80);
    ctx.lineTo(x, 245);
    ctx.stroke();
  }
  ctx.fillStyle = '#476ac5';
  ctx.fillRect(560, 330, 65, 100);
  ctx.fillRect(710, 230, 65, 200);
  const doc = new PDFDocument({ size: 'A4' }),
    chunks = [];
  const done = new Promise((resolve) => {
    doc.on('data', (b) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
  doc.text('PDF visual smoke test: preserve this native text.', 40, 40);
  doc.image(canvas.toBuffer('image/png'), 40, 90, { width: 510 });
  const nodes = [
    [50, 'Draft'],
    [230, 'Review'],
    [410, 'Publish'],
  ];
  for (const [x, title] of nodes) {
    doc.rect(x, 470, 120, 55).stroke();
    doc.text(title, x + 25, 490);
  }
  for (const x of [170, 350]) {
    doc
      .moveTo(x, 498)
      .lineTo(x + 60, 498)
      .stroke();
    doc
      .moveTo(x + 50, 491)
      .lineTo(x + 60, 498)
      .lineTo(x + 50, 505)
      .stroke();
  }
  doc.end();
  let bytes = await done;
  if (scan) {
    // 将完整样页栅格化后嵌入新 PDF，确保扫描版完全没有文字层。
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      verbosity: 0,
    });
    try {
      const original = await task.promise,
        page = await original.getPage(1);
      const viewport = page.getViewport({ scale: 2 });
      const raster = original.canvasFactory.create(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      try {
        await page.render({ canvasContext: raster.context, viewport }).promise;
        const scanned = new PDFDocument({ size: 'A4' }),
          pieces = [];
        const complete = new Promise((resolve) => {
          scanned.on('data', (b) => pieces.push(b));
          scanned.on('end', () => resolve(Buffer.concat(pieces)));
        });
        scanned.image(raster.canvas.toBuffer('image/png'), 0, 0, { width: 595.28, height: 841.89 });
        scanned.end();
        bytes = await complete;
      } finally {
        original.canvasFactory.destroy(raster);
      }
    } finally {
      await task.destroy();
    }
  }
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'fixture.pdf'), bytes);
  const store = new MemoryStore();
  await store.save('knowledgeBases', { id: 1, userId: 1 });
  await store.save('documents', { id: 1, userId: 1, knowledgeBaseId: 1 });
  await store.save('versions', { id: 1, documentId: 1 });
  const assets = new PageAssetsService(config, store),
    llm = new LlmService(config);
  const parser = new DocumentParser(new PdfVisualService(config, llm, assets));
  const parsed = await parser.parseStructured(bytes, 'fixture.pdf', undefined, {
    userId: 1,
    documentId: 1,
    versionId: 1,
  });
  await writeFile(join(root, 'parsed.json'), JSON.stringify(parsed, null, 2));
  const answer = await llm.complete(
    '依据以下正文和图片识别结果回答：图片代码是什么？表格 Alpha 和 Beta 分别是多少？Q2 比 Q1 多多少？流程中 Review 的下一步是什么？证据不足时说明。\n\n' +
      parsed.text,
  );
  await writeFile(join(root, 'answer.txt'), answer);
  const checks = {
    native: scan
      ? !parsed.blocks.some((b) => b.location.contentType === 'native')
      : parsed.text.includes('preserve this native text'),
    ocr: parsed.text.includes('IMAGE-CODE-42'),
    table: parsed.blocks.some((b) => b.location.contentType === 'table' && /42/.test(b.text)),
    figure: parsed.blocks.some(
      (b) => b.location.contentType === 'figure' && /Review|审核|审查/i.test(b.text),
    ),
    answer: /42/.test(answer) && /18/.test(answer) && /Publish|发布/i.test(answer),
  };
  console.log(JSON.stringify({ output: root, checks, answer }, null, 2));
  if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
