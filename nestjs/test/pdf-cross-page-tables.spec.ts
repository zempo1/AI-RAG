import PDFDocument from 'pdfkit';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';
import { RecursiveChunker } from '../src/modules/documents/chunkers/recursive.chunker';
import { ParsedDocument, paragraphBlocks } from '../src/modules/documents/parsers/parsed-document';
import { splitNativeTableBlocks } from '../src/modules/documents/parsers/pdf-table-layout';

type Variant =
  | 'continued'
  | 'chain'
  | 'running-header'
  | 'running-footer'
  | 'new-footer'
  | 'after-body'
  | 'different-columns'
  | 'new-header'
  | 'title'
  | 'body'
  | 'header'
  | 'gap'
  | 'single'
  | 'rotated';

/** Actual vector paths and native text, with no embedded fixture or external recognizer. */
async function tablePdf(variant: Variant = 'continued') {
  const pdf = new PDFDocument({ size: [600, 800], margin: 0, autoFirstPage: false });
  const pieces: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => {
    pdf.on('data', (piece) => pieces.push(piece));
    pdf.on('end', () => resolve(Buffer.concat(pieces)));
  });
  const grid = (top: number, rows: string[][], columns = [50, 150, 330, 550], fill = false) => {
    const ys = rows.map((_, i) => top + i * 30).concat(top + rows.length * 30);
    pdf.save().translate(5, 3);
    for (const x of columns) {
      if (fill) pdf.rect(x - 5, top - 3, 0.5, ys.at(-1)! - top).fill();
      else
        pdf
          .lineWidth(0.5)
          .moveTo(x - 5, top - 3)
          .lineTo(x - 5, ys.at(-1)! - 3)
          .stroke();
    }
    for (const y of ys) {
      if (fill) pdf.rect(columns[0] - 5, y - 3, columns.at(-1)! - columns[0], 0.5).fill();
      else
        pdf
          .moveTo(columns[0] - 5, y - 3)
          .lineTo(columns.at(-1)! - 5, y - 3)
          .stroke();
    }
    pdf.restore();
    rows.forEach((row, r) =>
      row.forEach((text, c) =>
        pdf.fontSize(10).text(text, columns[c] + 5, top + r * 30 + 8, { lineBreak: false }),
      ),
    );
  };
  pdf.addPage();
  if (variant === 'running-header')
    pdf.fontSize(10).text('Repeated book running header', 50, 30, { lineBreak: false });
  if (variant === 'rotated') (pdf.page as any).dictionary.data.Rotate = 90;
  pdf.fontSize(12).text('8. HL versus NHL', 50, 610, { lineBreak: false });
  grid(
    640,
    [
      ['Feature', 'HL', 'NHL'],
      ['Site', 'Superficial', 'Extranodal'],
      ['Nodes', 'Regular', 'Skip'],
    ],
    undefined,
    true,
  );
  if (variant === 'running-footer' || variant === 'new-footer')
    pdf.fontSize(10).text('Training Manual', 50, 770, { lineBreak: false });
  if (variant === 'after-body')
    pdf.fontSize(10).text('A new paragraph after this table.', 50, 740, { lineBreak: false });
  if (variant !== 'single' && variant !== 'rotated') {
    if (variant === 'gap') {
      pdf.addPage();
      pdf.text('Intervening page', 50, 100, { lineBreak: false });
    }
    pdf.addPage();
    if (variant === 'running-header')
      pdf.fontSize(10).text('Repeated book running header', 50, 30, { lineBreak: false });
    if (variant === 'title')
      pdf.fontSize(12).text('9. Another table', 50, 32, { lineBreak: false });
    if (variant === 'body')
      pdf.fontSize(10).text('A new paragraph before this table.', 50, 32, { lineBreak: false });
    const rows =
      variant === 'header' || variant === 'new-header'
        ? [
            [
              'Feature',
              variant === 'header' ? 'HL' : 'Type A',
              variant === 'header' ? 'NHL' : 'Type B',
            ],
            ['B symptoms', 'Common', 'Rare'],
          ]
        : [
            ['B symptoms', 'Common', 'Rare'],
            ['Course', 'Long', 'Short'],
          ];
    if (variant === 'chain')
      rows.push(...Array.from({ length: 20 }, (_, i) => [`Row ${i}`, `A ${i}`, `B ${i}`]));
    grid(60, rows, variant === 'different-columns' ? [50, 180, 350, 550] : undefined);
    if (variant === 'chain') {
      pdf.addPage();
      grid(60, [
        ['Treatment', 'Good', 'Variable'],
        ['Survival', 'Longer', 'Shorter'],
      ]);
    }
    pdf.fontSize(12).text('9. Diagnosis outside the table', 50, 160, { lineBreak: false });
    if (variant === 'running-footer')
      pdf.fontSize(10).text('Training Manual', 50, 770, { lineBreak: false });
  }
  pdf.end();
  return bytes;
}

const tables = (document: ParsedDocument) =>
  document.blocks.filter((b) => (b.location as any).table);

it.each<Variant>(['continued', 'running-header', 'running-footer'])(
  'detects native grids and links only the adjacent page tail and head, preserving exact ranges: %s',
  async (variant) => {
    const bytes = await tablePdf(variant);
    const parser = new DocumentParser();
    const pages: ParsedDocument[] = [];
    for await (const page of parser.parsePages(bytes)) pages.push(page);
    const full = await parser.parseStructured(bytes, 'native.pdf');
    const first = tables(pages[0]);
    const next = tables(pages[1]);
    expect(first.length).toBeGreaterThan(0);
    expect(next.length).toBeGreaterThan(0);
    const a = (first[0].location as any).table;
    const b = (next[0].location as any).table;
    expect(a).toMatchObject({
      continuedTo: 2,
      bbox: expect.any(Array),
      columns: expect.any(Array),
      rows: expect.any(Array),
    });
    expect(b).toMatchObject({ groupId: a.groupId, continuedFrom: 1 });
    expect(b.id).not.toBe(a.id);
    expect(a.columns).toHaveLength(4);
    expect(a.bbox[0]).toBeCloseTo(50 / 600, 2);
    expect(a.bbox[1]).toBeCloseTo(640 / 800, 2);
    expect(a.bbox[3]).toBeCloseTo(730 / 800, 2);
    expect(next.map((block) => block.text).join(' ')).toContain('B symptoms');
    expect(
      tables(full)
        .map((block) => block.text)
        .join(' '),
    ).not.toContain('Diagnosis');
    expect(full.text).toBe(pages.map((page) => page.text).join('\n'));
    let offset = 0;
    for (const page of pages) {
      const global = full.blocks.filter(
        (block) => block.location.page === page.blocks[0].location.page,
      );
      expect(global.map((block) => (block.location as any).table)).toEqual(
        page.blocks.map((block) => (block.location as any).table),
      );
      for (const block of page.blocks) {
        expect(page.text.slice(block.location.start, block.location.end)).toBe(block.text);
        for (const anchor of block.location.anchors || []) {
          expect(anchor.start).toBeGreaterThanOrEqual(block.location.start);
          expect(anchor.end).toBeLessThanOrEqual(block.location.end);
          expect(full.text.slice(anchor.start + offset, anchor.end + offset)).toBe(
            page.text.slice(anchor.start, anchor.end),
          );
        }
      }
      offset += page.text.length + 1;
    }
  },
);

it.each<Variant>([
  'different-columns',
  'new-header',
  'new-footer',
  'after-body',
  'title',
  'body',
  'header',
  'gap',
])('refuses a new table when the continuation is obstructed: %s', async (variant) => {
  const full = await new DocumentParser().parseStructured(await tablePdf(variant), 'native.pdf');
  const blocks = tables(full);
  expect(blocks.length).toBeGreaterThan(0);
  const first = (blocks[0].location as any).table;
  const last = (blocks.at(-1)!.location as any).table;
  expect(first.continuedTo).toBeUndefined();
  expect(last.continuedFrom).toBeUndefined();
  expect(last.groupId).not.toBe(first.groupId);
});

it.each<Variant>(['single', 'rotated'])(
  'keeps a standalone grid with stable page coordinates: %s',
  async (variant) => {
    const bytes = await tablePdf(variant);
    const parser = new DocumentParser();
    const full = await parser.parseStructured(bytes, 'native.pdf');
    const result = tables(full);
    expect(result.length).toBeGreaterThan(0);
    const table = (result[0].location as any).table;
    expect(table.continuedTo).toBeUndefined();
    expect(table.continuedFrom).toBeUndefined();
    if (variant === 'rotated') {
      expect(table.bbox[0]).toBeCloseTo(1 - 730 / 800, 2);
      expect(table.bbox[1]).toBeCloseTo(50 / 600, 2);
    }
    expect(
      (tables(await parser.parseStructured(bytes, 'native.pdf'))[0].location as any).table,
    ).toEqual(table);
  },
);

it('holds at most one native page ahead while preserving a stable group across three pages', async () => {
  const bytes = await tablePdf('chain');
  const completed: number[] = [];
  const parser = new DocumentParser();
  const stream = parser.parsePages(bytes, undefined, (done) => {
    completed.push(done);
  });
  const first = (await stream.next()).value!;
  expect(completed).toEqual([1, 2]);
  const second = (await stream.next()).value!;
  expect(completed).toEqual([1, 2, 3]);
  const third = (await stream.next()).value!;
  expect((await stream.next()).done).toBe(true);
  const metadata = [first, second, third].map((page) => tables(page)[0].location.table!);
  expect(metadata.map((table) => table.groupId)).toEqual([
    metadata[0].id,
    metadata[0].id,
    metadata[0].id,
  ]);
  expect(metadata[0].continuedTo).toBe(2);
  expect(metadata[1]).toMatchObject({ continuedFrom: 1, continuedTo: 3 });
  expect(metadata[2].continuedFrom).toBe(2);
  const full = await parser.parseStructured(bytes, 'native.pdf');
  expect(full.text).toBe([first.text, second.text, third.text].join('\n'));
  expect([...new Set(tables(full).map((block) => block.location.table!.groupId))]).toEqual([
    metadata[0].id,
  ]);
});

it('does not combine native table parents with body text or another table', async () => {
  const text = 'Before\n\nFirst table\n\nSecond table\n\nAfter';
  const blocks = paragraphBlocks(text, 1);
  blocks.forEach((block) => (block.location.contentType = 'native'));
  (blocks[1].location as any).table = {
    id: 'p1-a',
    groupId: 'a',
    bbox: [0, 0, 1, 1],
    columns: [0, 0.5, 1],
    rows: [0, 1],
  };
  (blocks[2].location as any).table = {
    id: 'p1-b',
    groupId: 'b',
    bbox: [0, 0, 1, 1],
    columns: [0, 0.5, 1],
    rows: [0, 1],
  };
  const tokenizer = {
    windows: async (value: string) => [
      { text: value, start: 0, end: value.length, tokenCount: value.length },
    ],
  };
  const chunks = await new RecursiveChunker().splitTokenStructured(
    { text, blocks },
    tokenizer as any,
    { tokenizer: 'test' } as any,
  );
  expect(chunks.map((chunk) => chunk.retrievalMetadata.parentText)).toEqual([
    'Before',
    'First table',
    'Second table',
    'After',
  ]);
});

it('never absorbs an unrepresented text gap between blocks of the same table', async () => {
  const text = 'First row\n\nUNRELATED\n\nSecond row';
  const blocks = paragraphBlocks(text, 1).filter((block) => block.text !== 'UNRELATED');
  for (const block of blocks) {
    block.location.contentType = 'native';
    (block.location as any).table = {
      id: 'same',
      groupId: 'same',
      bbox: [0, 0, 1, 1],
      columns: [0, 0.5, 1],
      rows: [0, 1],
    };
  }
  const tokenizer = {
    windows: async (value: string) => [
      { text: value, start: 0, end: value.length, tokenCount: value.length },
    ],
  };
  const chunks = await new RecursiveChunker().splitTokenStructured(
    { text, blocks },
    tokenizer as any,
    { tokenizer: 'test' } as any,
  );
  expect(chunks.map((chunk) => chunk.retrievalMetadata.parentText)).toEqual([
    'First row',
    'Second row',
  ]);
});

it('splits a mixed native paragraph into continuous ranges and keeps each source anchor with its text', () => {
  const text = 'Left cell\nOutside prose\nRight cell';
  const table = {
    id: 'grid',
    groupId: 'grid',
    bbox: [0.05, 0.05, 0.6, 0.4] as [number, number, number, number],
    columns: [0.05, 0.3, 0.6],
    rows: [0.05, 0.2, 0.4],
  };
  const values = [
    {
      text: 'Left cell',
      bbox: [0.1, 0.1, 0.2, 0.12] as [number, number, number, number],
      index: 0,
    },
    {
      text: 'Outside prose',
      bbox: [0.7, 0.1, 0.9, 0.12] as [number, number, number, number],
      index: 1,
    },
    {
      text: 'Right cell',
      bbox: [0.35, 0.1, 0.5, 0.12] as [number, number, number, number],
      index: 2,
    },
  ];
  const ranges = [
    { start: 0, end: 9 },
    { start: 10, end: 23 },
    { start: 24, end: 34 },
  ];
  const blocks = paragraphBlocks(text, 1);
  blocks[0].location.anchors = values.map((item, index) => ({
    page: 1,
    ...ranges[index],
    rects: [item.bbox],
    kind: 'native',
  }));
  const result = splitNativeTableBlocks(blocks, [table], values, ranges);
  expect(result.map((block) => [block.text, block.location.table?.id])).toEqual([
    ['Left cell', 'grid'],
    ['Outside prose', undefined],
    ['Right cell', 'grid'],
  ]);
  for (const block of result) {
    expect(text.slice(block.location.start, block.location.end)).toBe(block.text);
    expect(block.location.anchors).toHaveLength(1);
    const anchor = block.location.anchors![0];
    expect(text.slice(anchor.start, anchor.end)).toBe(block.text);
  }
});
