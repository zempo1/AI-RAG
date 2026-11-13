import {
  sliceSourceLocation,
  shiftSourceLocation,
  mergeSourceLocations,
  withoutSourceGeometry,
} from '../src/modules/documents/parsers/source-anchors';
import { RecursiveChunker } from '../src/modules/documents/chunkers/recursive.chunker';
import { compactSearchEvidence } from '../src/modules/agent/search-evidence';
import { ConfigService } from '@nestjs/config';
import { TokenizerService } from '../src/modules/embeddings/tokenizer.service';
import { legacyModelProfile } from '../src/modules/embeddings/model-profile';
import { AgentService } from '../src/modules/agent/agent.service';
import { AgentBudget } from '../src/modules/agent/agent-budget';
import { AgentTools } from '../src/modules/agent/agent-tools';
import { QdrantVectorStore } from '../src/modules/vector-store/qdrant-vector-store.service';

const location: any = {
  page: 1,
  paragraph: 1,
  heading: null,
  contentType: 'native',
  start: 0,
  end: 12,
  anchorVersion: 1,
  anchors: [
    { page: 1, start: 0, end: 5, kind: 'native', rects: [[0.1, 0.1, 0.5, 0.2]] },
    { page: 1, start: 7, end: 12, kind: 'native', rects: [[0.1, 0.3, 0.5, 0.4]] },
  ],
};

it('clips evidence ranges then shifts UTF-16 offsets without mutating original geometry', () => {
  const cut = sliceSourceLocation(location, 3, 8, 100);
  expect(cut).toMatchObject({
    start: 103,
    end: 108,
    anchors: [
      { start: 103, end: 105 },
      { start: 107, end: 108 },
    ],
  });
  expect(location.anchors[0].start).toBe(0);
  expect(shiftSourceLocation(location, 20).anchors?.[1].start).toBe(27);
  expect(sliceSourceLocation(location, 5, 7).anchors).toEqual([]);
});

it('merges source geometry and omits it only from external model/vector projections', () => {
  const a = sliceSourceLocation(location, 0, 8),
    b = sliceSourceLocation(location, 7, 12);
  expect(mergeSourceLocations(a, b).anchors).toHaveLength(3);
  const original = { location, retrievalMetadata: { parentLocation: location }, text: '原文' };
  const projected = withoutSourceGeometry(original);
  expect(projected).toEqual({
    location: { page: 1, paragraph: 1, heading: null, contentType: 'native', start: 0, end: 12 },
    retrievalMetadata: {
      parentLocation: {
        page: 1,
        paragraph: 1,
        heading: null,
        contentType: 'native',
        start: 0,
        end: 12,
      },
    },
    text: '原文',
  });
  expect(original.location.anchors).toHaveLength(2);
});

it('keeps all merged paragraphs but crops anchors to each child range and global offset', () => {
  const doc: any = {
    text: 'abcde\n\nfghij',
    blocks: [
      { text: 'abcde', location: sliceSourceLocation(location, 0, 5) },
      { text: 'fghij', location: { ...sliceSourceLocation(location, 7, 12), paragraph: 2 } },
    ],
  };
  const chunks = new RecursiveChunker().splitStructured(doc, 3, 0, 100);
  expect(chunks[0].location.anchors).toEqual([expect.objectContaining({ start: 100, end: 103 })]);
  expect(chunks.at(-1)?.location.anchors).toEqual([
    expect.objectContaining({ start: 110, end: 112 }),
  ]);
});

it('merges both sides of overlapping Agent evidence instead of losing right-hand highlights', () => {
  const base: any = {
    number: 1,
    documentId: 1,
    knowledgeBaseId: 1,
    versionId: 1,
    indexRevisionId: 1,
    chunkId: 1,
    filename: 'a.pdf',
    score: 1,
  };
  const result = compactSearchEvidence(
    [
      {
        ...base,
        evidenceId: 'a',
        text: 'abcde\n\nf',
        location: sliceSourceLocation(location, 0, 8),
      },
      {
        ...base,
        chunkId: 2,
        evidenceId: 'b',
        text: 'fghij',
        location: sliceSourceLocation(location, 7, 12),
      },
    ],
    (source) => ({ ...source, evidenceId: 'merged' }),
  );
  expect(result[0].text).toBe('abcde\n\nfghij');
  expect(result[0].location?.anchors?.some((a) => a.end === 12)).toBe(true);
});

it('keeps merged paragraph anchors in both token child and parent locations', async () => {
  const tokenizer = new TokenizerService(new ConfigService({ STORAGE_DRIVER: 'memory' }));
  const chunks = await new RecursiveChunker().splitTokenStructured(
    {
      text: 'abcde\n\nfghij',
      blocks: [
        { text: 'abcde', location: sliceSourceLocation(location, 0, 5) },
        { text: 'fghij', location: { ...sliceSourceLocation(location, 7, 12), paragraph: 2 } },
      ],
    },
    tokenizer,
    { ...legacyModelProfile(), tokenizer: 'test:unicode-v1' },
    50,
  );
  expect(chunks[0].location.anchors?.map((a) => [a.start, a.end])).toEqual([
    [50, 55],
    [57, 62],
  ]);
  expect((chunks[0].retrievalMetadata.parentLocation as any).anchors).toEqual(
    chunks[0].location.anchors,
  );
});

it('crops Agent read offset and byte limit before storing the retained evidence', async () => {
  const source: any = {
    number: 1,
    documentId: 1,
    text: 'abcdefghij',
    location: {
      ...location,
      start: 0,
      end: 10,
      anchors: [
        { page: 1, start: 0, end: 4, rects: [[0, 0, 0.2, 0.1]], kind: 'native' },
        { page: 1, start: 4, end: 10, rects: [[0, 0.2, 0.5, 0.3]], kind: 'native' },
      ],
    },
    evidenceId: 'initial',
  };
  const tools = new AgentTools(
    {
      verify: async () => {},
      read: async () => ({ evidence: [source], complete: true }),
      original: (s: any) => ({ ...s, evidenceId: 'cut' }),
    } as any,
    {} as any,
    new ConfigService({ AGENT_TOOL_TOKENS: 605 }),
    () => ({}),
  );
  const result = await tools.execute(
    { name: 'read_document', args: { documentId: 1, offset: 5 } },
    { scope: { documents: [{ documentId: 1 }] }, evidence: [] } as any,
    {},
    {} as any,
  );
  expect(result.evidence?.[0].location).toMatchObject({
    start: 5,
    end: 10,
    anchors: [{ start: 5, end: 10 }],
  });
});

it('projects checkpoint history before model prompts without mutating saved citations', async () => {
  const history = [
    { role: 'assistant', content: '之前的回答', citations: [{ text: '原文', location }] },
  ];
  const state: any = {
    history,
    plan: { intent: 'general' },
    question: '继续',
    evidence: [],
    steps: [],
    scope: { documents: [] },
    budget: AgentBudget.initial(),
    phase: 'finalize',
  };
  const agent = new AgentService(
    { pack: async () => ({ sources: [], complete: true }), context: () => '' } as any,
    {} as any,
    {} as any,
    new ConfigService({}),
    {} as any,
  );
  const result = await (agent as any).context(state, {}, false);
  expect(result.prompt).toContain('之前的回答');
  expect(result.prompt).not.toContain('anchors');
  expect(history[0].citations[0].location.anchors).toHaveLength(2);
});

it('writes scoped Qdrant payloads without duplicating child or parent geometry', async () => {
  const vectors = new QdrantVectorStore(new ConfigService({ QDRANT_URL: 'http://127.0.0.1:6333' }));
  let written: any;
  // Replace only the remote database boundary; payload construction stays real.
  (vectors as any).client = {
    collectionExists: async () => ({ exists: true }),
    getCollection: async () => ({
      config: { params: { vectors: { size: 2, distance: 'Cosine' } } },
    }),
    createPayloadIndex: async () => {},
    upsert: async (_collection: string, body: any) => {
      written = body;
    },
  };
  const segment = {
    userId: 1,
    knowledgeBaseId: 2,
    documentId: 3,
    versionId: 4,
    indexRevisionId: 5,
    chunkId: 6,
    chunkIndex: 0,
    filename: 'test.pdf',
    text: '原文',
    location,
    retrievalMetadata: { parentLocation: location },
  };
  await vectors.addAll([[1, 0]], [segment], { ...legacyModelProfile(), dimensions: 2 });
  expect(written.points[0].payload).toMatchObject({
    userId: 1,
    documentId: 3,
    indexRevisionId: 5,
    chunkId: 6,
    text: '原文',
  });
  expect(JSON.stringify(written.points[0].payload)).not.toContain('anchors');
  expect(segment.location.anchors).toHaveLength(2);
});
