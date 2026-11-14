import PDFDocument from 'pdfkit';
import { pipeline } from './helpers/pipeline';
import { RetrievalService } from '../src/modules/rag/retrieval.service';
import { PdfTableBackfillService } from '../src/modules/rag/pdf-table-backfill.service';
import { DocumentOriginalsService } from '../src/modules/documents/document-originals.service';
import { AgentService } from '../src/modules/agent/agent.service';
import { AgentBudget } from '../src/modules/agent/agent-budget';

async function longTable() {
  const pdf = new PDFDocument({ size: [600, 800], margin: 0, autoFirstPage: false });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    pdf.on('data', (b) => chunks.push(b));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (let p = 1; p <= 3; p++) {
    pdf.addPage();
    const xs = [50, 150, 330, 550],
      top = p === 1 ? 640 : 70,
      bottom = p === 3 ? 130 : 730;
    const ys = p === 2 ? [top, 400, bottom] : [top, top + 30, bottom];
    for (const x of xs) pdf.moveTo(x, top).lineTo(x, bottom).stroke();
    for (const y of ys) pdf.moveTo(xs[0], y).lineTo(xs[3], y).stroke();
    const rows =
      p === 1
        ? [
            ['Feature', 'HL', 'NHL'],
            ['Site', 'Left', 'Right'],
          ]
        : p === 2
          ? [
              ['B symptoms', 'Common', 'Rare'],
              ['Course', 'Long', 'Short'],
            ]
          : [
              ['Treatment', 'Sensitive', 'Variable'],
              ['Last row', 'Present', 'Absent'],
            ];
    rows.forEach((row, i) =>
      row.forEach((text, c) =>
        pdf.fontSize(10).text(text, xs[c] + 5, ys[i] + 8, { lineBreak: false }),
      ),
    );
  }
  pdf.end();
  return done;
}

it('lazily repairs an old three-page table from the first page and rechecks ownership on warm reads', async () => {
  const p = await pipeline();
  try {
    const uploaded = await p.documents.ingest(await longTable(), 'legacy.pdf', 1);
    await p.indexing.process(uploaded.taskId);
    for (const row of await p.store.list('chunks', { documentId: uploaded.documentId })) {
      const location = structuredClone(row.location);
      delete location.table;
      const metadata = structuredClone(row.retrievalMetadata);
      if (metadata?.parentLocation) delete metadata.parentLocation.table;
      await p.store.save('chunks', { id: row.id, location, retrievalMetadata: metadata });
    }
    const backfill = new PdfTableBackfillService(new DocumentOriginalsService(p.config, p.store));
    const service = new RetrievalService(
      p.embeddings as any,
      p.vectors,
      p.store,
      p.libraries,
      undefined,
      undefined,
      p.config,
      backfill,
    );
    const scope = await service.createScope(1, uploaded.knowledgeBaseId),
      session = await service.open(scope);
    const seed = session.chunks.find((c) => c.location.page === 1)!;
    await backfill.ensure(session, [seed.id]);
    const packed = await service.pack(
      service.expand(session, [{ id: seed.id, score: 1 }], false),
      16000,
    );
    const table = packed.sources.find((s) => s.location?.table)!;
    expect(table.text).toContain('Last row');
    expect([...new Set(table.location!.anchors!.map((a) => a.page))]).toEqual([1, 2, 3]);
    // A persisted read_document result survives a Worker handoff; session maps do not.
    const saved = JSON.parse(JSON.stringify(service.original(service.citation(session, seed))));
    const restoredSession = await service.open(scope);
    expect(restoredSession.tables).toBeUndefined();
    const restored = await service.pack(
      await service.resolveTableEvidence(restoredSession, [saved]),
      16000,
    );
    expect(restored.sources.some((s) => s.text.includes('Last row'))).toBe(true);
    const agent = new AgentService(service, {} as any, {} as any, p.config, p.store);
    const context = await (agent as any).context(
      {
        scope,
        evidence: [saved],
        history: [],
        question: 'Compare HL and NHL course',
        plan: { intent: 'search' },
        phase: 'finalize',
        steps: [],
        budget: AgentBudget.initial(),
      },
      {},
      false,
    );
    expect(context.sources.some((s: any) => s.text.includes('Last row'))).toBe(true);
    expect(context.prompt).not.toContain('groupId');
    expect(context.prompt).not.toContain('continuedFrom');
    await service.read(session, { documentId: uploaded.documentId });
    expect(
      (await p.store.list('chunks', { documentId: uploaded.documentId })).every(
        (c) => !c.location.table,
      ),
    ).toBe(true);
    await p.store.save('knowledgeBases', { id: uploaded.knowledgeBaseId, userId: 2 });
    await expect(service.read(session, { documentId: uploaded.documentId })).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    await p.cleanup();
  }
});
