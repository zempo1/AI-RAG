import PDFDocument from 'pdfkit';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';
import { RecursiveChunker } from '../src/modules/documents/chunkers/recursive.chunker';

export async function pdf(pages: string[] = ['Native text']): Promise<Buffer> {
  const doc = new PDFDocument();
  const buffers: Buffer[] = [];
  const result = new Promise<Buffer>((resolve) => {
    doc.on('data', (b) => buffers.push(b));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
  pages.forEach((text, i) => {
    if (i) doc.addPage();
    if (text) doc.text(text);
  });
  doc.end();
  return result;
}

it('indexes visual supplements alongside native text with exact offsets and page provenance', async () => {
  const visual = {
    enabled: true,
    page: async () => ({
      image: { versionId: 4, page: 1, profile: 'a'.repeat(64) },
      blocks: [
        { type: 'ocr', text: '图片中的独有文字' },
        { type: 'figure', text: '提交 → 审核 → 发布' },
      ],
    }),
  };
  const parser = new (DocumentParser as any)(visual);
  const parsed = await parser.parseStructured(await pdf(), 'a.pdf', undefined, {
    userId: 1,
    documentId: 2,
    versionId: 4,
  });
  expect(parsed.text).toContain('Native text');
  expect(parsed.text).toContain('图片中的独有文字');
  expect(parsed.text).toContain('提交 → 审核 → 发布');
  const chunks = new RecursiveChunker().splitStructured(parsed);
  expect(chunks.find((c) => c.text.includes('提交'))?.location).toMatchObject({
    page: 1,
    contentType: 'figure',
    pageImage: { versionId: 4, page: 1 },
  });
  for (const chunk of chunks)
    expect(parsed.text.slice(chunk.location.start, chunk.location.end)).toBe(chunk.text);
});

it('accepts image-only PDFs when vision supplies text, without changing Markdown parsing', async () => {
  const parser = new (DocumentParser as any)({
    enabled: true,
    page: async () => ({
      image: { versionId: 1, page: 1, profile: 'b'.repeat(64) },
      blocks: [{ type: 'ocr', text: '扫描内容' }],
    }),
  });
  const parsed = await parser.parseStructured(await pdf(['']), 'scan.pdf', undefined, {
    userId: 1,
    documentId: 1,
    versionId: 1,
  });
  expect(parsed.text).toContain('扫描内容');
  expect((await parser.parseStructured(Buffer.from('# 标题\n\n正文'), 'a.md')).text).toBe(
    '# 标题\n\n正文',
  );
});

it('preserves visual provenance through token chunking and parent expansion metadata', async () => {
  const text = '原生文字\n\n图解：甲指向乙';
  const parsed: any = {
    text,
    blocks: [
      {
        text: '原生文字',
        location: { page: 1, paragraph: 1, heading: null, start: 0, end: 4, contentType: 'native' },
      },
      {
        text: '图解：甲指向乙',
        location: {
          page: 1,
          paragraph: 2,
          heading: null,
          start: 6,
          end: text.length,
          contentType: 'figure',
          pageImage: { versionId: 1, page: 1, profile: 'a'.repeat(64) },
        },
      },
    ],
  };
  const { ConfigService } = await import('@nestjs/config');
  const { TokenizerService } = await import('../src/modules/embeddings/tokenizer.service');
  const chunks = await new RecursiveChunker().splitTokenStructured(
    parsed,
    new TokenizerService(new ConfigService({ STORAGE_DRIVER: 'memory' })),
    { tokenizer: 'test:unicode-v1' } as any,
  );
  const figure = chunks.find((c) => c.text.includes('甲'))!;
  expect(figure.location.contentType).toBe('figure');
  expect(figure.retrievalMetadata.parentLocation).toMatchObject({
    contentType: 'figure',
    pageImage: { page: 1 },
  });
  expect(figure.text).not.toContain('原生文字');
});
