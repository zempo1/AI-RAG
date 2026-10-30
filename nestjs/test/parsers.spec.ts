import { DocumentParser } from '../src/modules/documents/parsers/document.parser';
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';

async function pdf(text?: string, font?: string): Promise<Buffer> {
  const document = new PDFDocument();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    document.on('data', (b) => chunks.push(b));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
  if (font) document.font(font);
  if (text) document.text(text);
  document.end();
  return done;
}

describe('real document parsing', () => {
  const parser = new DocumentParser();
  it('reads UTF-8 Markdown without removing markup', async () => {
    expect(await parser.parse(Buffer.from('# 中文\n\n正文'), 'a.md')).toBe('# 中文\n\n正文');
  });
  it('extracts text from a real PDF', async () => {
    expect(await parser.parse(await pdf('RAG knowledge document'), 'a.pdf')).toContain(
      'RAG knowledge document',
    );
  });
  const chineseFont = 'C:/Windows/Fonts/simhei.ttf';
  (existsSync(chineseFont) ? it : it.skip)(
    'extracts Chinese from a font-embedded PDF',
    async () => {
      expect(await parser.parse(await pdf('中文知识库测试', chineseFont), '中文.pdf')).toContain(
        '中文知识库测试',
      );
    },
  );
  it('rejects image-only or blank PDF without pretending to perform OCR', async () => {
    await expect(parser.parse(await pdf(), 'blank.pdf')).rejects.toThrow('OCR');
  });
  it('rejects corrupt PDF and malformed UTF-8', async () => {
    await expect(parser.parse(Buffer.from('%PDF-broken'), 'broken.pdf')).rejects.toThrow();
    await expect(parser.parse(Buffer.from([0xff, 0xfe, 0xff]), 'bad.md')).rejects.toThrow();
  });
});
