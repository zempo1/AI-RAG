import { RetrievalService } from '../src/modules/rag/retrieval.service';
import type { RetrievalSession } from '../src/modules/rag/retrieval.types';
import { normalizeCitations } from '../src/modules/rag/citations';
import { sliceSourceLocation } from '../src/modules/documents/parsers/source-anchors';

const retrieval = new RetrievalService({} as any, {} as any, {} as any, {} as any);
function table(page: number, rows: string[][], start: number, groupId = 'comparison') {
  const top = page === 39 ? 0.8 : 0.1,
    columns = [0.1, 0.35, 0.6, 0.9];
  const boundaries = Array.from({ length: rows.length + 1 }, (_, i) => top + i * 0.03);
  let at = start;
  const anchors = rows.flatMap((row, i) =>
    row.map((value, j) => {
      const result = {
        page,
        start: at,
        end: at + value.length,
        kind: 'native',
        rects: [
          [
            columns[j] + 0.005,
            boundaries[i] + 0.005,
            columns[j + 1] - 0.005,
            boundaries[i + 1] - 0.005,
          ],
        ],
      };
      at += value.length + 2;
      return result;
    }),
  );
  const text = rows.flat().join('\n\n');
  return {
    id: page,
    documentId: 1,
    versionId: 2,
    indexRevisionId: 3,
    chunkIndex: page,
    text,
    location: {
      start,
      end: start + text.length,
      page,
      paragraph: 1,
      heading: null,
      contentType: 'native',
      anchorVersion: 1,
      anchors,
      table: {
        id: `table-${page}`,
        groupId,
        bbox: [0.1, top, 0.9, boundaries.at(-1)],
        columns,
        rows: boundaries,
        title: 'HL 与 NHL 临床特点',
      },
    },
  };
}
function fixture() {
  const first = table(
    39,
    [
      ['指标', 'HL', 'NHL'],
      ['部位', '浅表淋巴结', '结外40%'],
    ],
    100,
  );
  const next = table(
    40,
    [
      ['B症状', '多见', '少见'],
      ['病程', '慢、长，治疗反应好', '快、短，治疗反应不一'],
    ],
    1000,
  );
  const unrelated = {
    ...table(40, [['血液学改变', '贫血', 'ESR升高']], 2000, 'other'),
    id: 41,
    chunkIndex: 41,
  };
  const chunks = [first, next, unrelated];
  const session: RetrievalSession = {
    scope: {
      userId: 1,
      knowledgeBaseId: 1,
      documents: [{ documentId: 1, filename: 'notes.pdf', indexRevisionId: 3 }],
    },
    chunks,
    documents: [],
    byChunk: new Map(chunks.map((c) => [c.id, c])),
    byDoc: new Map([[1, { id: 1, filename: 'notes.pdf' }]]),
    revisions: new Map(),
  };
  return { first, next, unrelated, session };
}

it.each([39, 40])(
  'retrieving page %s expands the complete table and saves both pages under one citation',
  async (page) => {
    const { session } = fixture();
    const evidence = retrieval.expand(session, [{ id: page, score: 1 }], false);
    const packed = await retrieval.pack(evidence, 10000);
    const source = packed.sources.find(
      (s) => s.text.includes('B症状') && s.text.includes('浅表淋巴结'),
    )!;
    expect(source).toBeDefined();
    expect(source.text).toContain('| B症状 | 多见 | 少见 |');
    expect(source.text).toContain('治疗反应不一');
    expect(source.text).not.toContain('血液学改变');
    expect(packed.sources).toHaveLength(1);
    const saved = normalizeCitations(`对比结论[${source.number}]`, packed.sources).citations[0];
    expect([...new Set(saved.location!.anchors!.map((a) => a.page))]).toEqual([39, 40]);
    expect(
      saved.sourceSegments!.every((s) => s.text.length === s.location.end - s.location.start),
    ).toBe(true);
  },
);

it('uses identical table headers once when the next page repeats them', async () => {
  const { first, session } = fixture();
  const next = table(
    40,
    [
      ['指标', 'HL', 'NHL'],
      ['B症状', '多见', '少见'],
    ],
    1000,
  );
  session.chunks = [first, next];
  session.byChunk.set(40, next);
  const packed = await retrieval.pack(
    retrieval.expand(session, [{ id: 39, score: 1 }], false),
    10000,
  );
  expect(packed.sources).toHaveLength(1);
  expect(packed.sources[0].text.match(/\| 指标 \| HL \| NHL \|/g)).toHaveLength(1);
});

it('does not merge equal-looking tables from different documents or versions', async () => {
  const { first, next } = fixture();
  const a = retrieval.original({
    ...first,
    documentId: 1,
    chunkId: 39,
    filename: 'a.pdf',
    number: 0,
    knowledgeBaseId: 1,
    score: 1,
  });
  const b = retrieval.original({
    ...next,
    documentId: 2,
    chunkId: 40,
    filename: 'b.pdf',
    number: 0,
    knowledgeBaseId: 1,
    score: 1,
  });
  const packed = await retrieval.pack([a, b] as any, 10000);
  expect(packed.sources).toHaveLength(2);
  expect(
    packed.sources.every(
      (s) =>
        new Set(s.sourceSegments?.flatMap((p) => p.location.anchors?.map((a) => a.page) || []))
          .size <= 1,
    ),
  ).toBe(true);
});

it('orders mixed-font punctuation by the same text baseline within each cell', async () => {
  const row = table(
    39,
    [
      ['维度', '值', '其他'],
      ['部位', '浅表', '结外:40%'],
    ],
    100,
  );
  const last = row.location.anchors.pop()!;
  row.location.anchors.push(
    { ...last, end: last.start + 2, rects: [[0.605, 0.84, 0.66, 0.858]] },
    { ...last, start: last.start + 2, rects: [[0.661, 0.838, 0.8, 0.853]] },
  );
  const source = retrieval.original({
    ...row,
    chunkId: 39,
    filename: 'a.pdf',
    number: 0,
    knowledgeBaseId: 1,
    score: 1,
  } as any);
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources[0].text).toContain('| 部位 | 浅表 | 结外:40% |');
});

it('does not silently discard table text whose geometry is missing', async () => {
  const row = table(
    39,
    [
      ['指标', 'HL', 'NHL'],
      ['病程', '慢', '治疗反应不一'],
    ],
    100,
  );
  row.location.anchors.pop();
  const source = retrieval.original({
    ...row,
    chunkId: 39,
    filename: 'a.pdf',
    number: 0,
    knowledgeBaseId: 1,
    score: 1,
  } as any);
  const packed = await retrieval.pack([source], 10000);
  expect(packed.sources[0].text).toContain('治疗反应不一');
  expect(packed.sources[0].sourceSegments).toBeUndefined();
});

it('treats the complete table as atomic when the context budget is too small', async () => {
  const { session } = fixture();
  const packed = await retrieval.pack(retrieval.expand(session, [{ id: 39, score: 1 }], false), 50);
  expect(packed.complete).toBe(false);
  expect(packed.sources).toEqual([]);
});

it('keeps a multi-page table atomic and preserves its raw text when geometry is incomplete', async () => {
  const { next, session } = fixture();
  next.location.anchors.pop();
  const evidence = retrieval.expand(session, [{ id: 39, score: 1 }], false);
  const full = await retrieval.pack(evidence, 10000);
  expect(full.sources).toHaveLength(1);
  expect(full.sources[0].text).toContain('治疗反应不一');
  expect([
    ...new Set(
      full.sources[0].sourceSegments!.flatMap((p) => p.location.anchors!.map((a) => a.page)),
    ),
  ]).toEqual([39, 40]);
  const small = await retrieval.pack(evidence, 52);
  expect(small.complete).toBe(false);
  expect(small.sources).toEqual([]);
});

it('deduplicates overlapping child ranges in the raw table fallback', async () => {
  const { first, next } = fixture();
  next.location.anchors.pop();
  const source = (row: typeof first, id: number, from: number, to: number) =>
    retrieval.original({
      ...row,
      chunkId: id,
      filename: 'notes.pdf',
      number: 0,
      knowledgeBaseId: 1,
      score: 1,
      text: row.text.slice(from, to),
      location: sliceSourceLocation(
        row.location as any,
        row.location.start + from,
        row.location.start + to,
      ),
    } as any);
  const sources = [
    source(first, 101, 0, first.text.indexOf('结外40%')),
    source(first, 102, first.text.indexOf('部位'), first.text.length),
    source(next, 103, 0, next.text.length),
  ];
  // An identical saved range can carry only a subset of the earlier geometry.
  sources.splice(1, 0, {
    ...sources[0],
    location: { ...sources[0].location!, anchors: sources[0].location!.anchors!.slice(1) },
  });
  const packed = await retrieval.pack(sources, 10000);
  expect(packed.sources).toHaveLength(1);
  expect(packed.sources[0].text.match(/浅表淋巴结/g)).toHaveLength(1);
  expect(
    packed.sources[0].sourceSegments!.every(
      (p) => p.text.length === p.location.end - p.location.start,
    ),
  ).toBe(true);
  expect(packed.sources[0].sourceSegments![0].chunkIds).toEqual([101, 102]);
  expect(
    packed.sources[0].sourceSegments![0].location.anchors!.some(
      (a) => a.start === first.location.start,
    ),
  ).toBe(true);
});
