import { DocumentParser } from '../src/modules/documents/parsers/document.parser';
import { RecursiveChunker } from '../src/modules/documents/chunkers/recursive.chunker';
import PDFDocument from 'pdfkit';

it('keeps Markdown headings, paragraph numbers and exact source offsets through splitting', async () => {
  const source = '# 数据库\n\n事务保证一致性。\n\n## 索引\n\n向量索引用于检索。';
  const parsed = await new DocumentParser().parseStructured(Buffer.from(source), 'a.md');
  const chunks = new RecursiveChunker().splitStructured(parsed);
  expect(chunks.map((c) => c.text)).toContain('事务保证一致性。');
  const chunk = chunks.find((c) => c.text === '向量索引用于检索。')!;
  expect(chunk.location).toMatchObject({ page: null, paragraph: 4, heading: '索引' });
  for (const c of chunks) expect(parsed.text.slice(c.location.start, c.location.end)).toBe(c.text);
});

it('keeps real PDF pages separate and reports actual page progress', async () => {
  const doc = new PDFDocument();
  const buffers: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => {
    doc.on('data', (b) => buffers.push(b));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
  doc.text('First page source');
  doc.addPage();
  doc.text('Second page source');
  doc.end();
  const progress: number[] = [];
  const parsed = await new DocumentParser().parseStructured(await bytes, 'a.pdf', (done, total) => {
    progress.push(done / total);
  });
  const chunks = new RecursiveChunker().splitStructured(parsed);
  expect(chunks.find((c) => c.text.includes('First page'))?.location.page).toBe(1);
  expect(chunks.find((c) => c.text.includes('Second page'))?.location.page).toBe(2);
  expect(progress).toEqual([0.5, 1]);
});
