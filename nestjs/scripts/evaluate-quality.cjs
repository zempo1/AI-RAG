/* Explicit --live runs paid model calls on synthetic fixtures only.
 * Uses MemoryStore and an ephemeral originals directory; never connects to MySQL/Qdrant. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '../../docs/evaluation/accuracy');
  const documents = JSON.parse(await fs.readFile(path.join(root, 'documents.json'), 'utf8'));
  const cases = JSON.parse(await fs.readFile(path.join(root, 'cases.json'), 'utf8'));
  if (!process.argv.includes('--live')) {
    console.log(
      JSON.stringify(
        {
          status: 'not_run',
          cases: cases.length,
          documents: documents.length,
          annotationStatus: 'authored_requires_human_review',
          message:
            'Dry run only. Review fixtures, configure API keys/tokenizers, then pass --live to incur external API costs.',
        },
        null,
        2,
      ),
    );
    return;
  }
  require('dotenv/config');
  require('reflect-metadata');
  const { ConfigService } = require('@nestjs/config');
  const { validateConfig } = require('../dist/config/configuration');
  const { MemoryStore } = require('../dist/persistence/memory.store');
  const {
    KnowledgeBasesService,
  } = require('../dist/modules/knowledge-bases/knowledge-bases.service');
  const { TasksService } = require('../dist/modules/tasks/tasks.service');
  const { DocumentsService } = require('../dist/modules/documents/documents.service');
  const { IndexingService } = require('../dist/modules/documents/indexing.service');
  const { DocumentParser } = require('../dist/modules/documents/parsers/document.parser');
  const { RecursiveChunker } = require('../dist/modules/documents/chunkers/recursive.chunker');
  const { EmbeddingsService } = require('../dist/modules/embeddings/embeddings.service');
  const { TokenizerService } = require('../dist/modules/embeddings/tokenizer.service');
  const {
    InMemoryVectorStore,
  } = require('../dist/modules/vector-store/in-memory-vector-store.service');
  const { QualityModelsService } = require('../dist/modules/rag/quality-models.service');
  const { RagService } = require('../dist/modules/rag/rag.service');
  const { SummaryService } = require('../dist/modules/rag/summary.service');
  const { LlmService } = require('../dist/modules/llm/llm.service');
  const { normalizeCitations, NO_CONTEXT_ANSWER } = require('../dist/modules/rag/citations');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-quality-eval-'));
  const config = new ConfigService(
    validateConfig({
      ...process.env,
      STORAGE_DRIVER: 'mysql',
      DB_USER: 'unused',
      DB_PASSWORD: 'unused',
      JWT_SECRET: 'synthetic-evaluation-only-secret-32-characters',
      ORIGINALS_DIR: temp,
      EMBEDDING_PROVIDER: 'dashscope',
    }),
  );
  for (const key of ['EMBEDDING_API_KEY', 'CHAT_API_KEY', 'EMBEDDING_TOKENIZER', 'CHAT_TOKENIZER'])
    if (!config.get(key)) throw new Error('Missing ' + key + ' for live evaluation');
  const store = new MemoryStore(),
    libraries = new KnowledgeBasesService(store),
    tasks = new TasksService(store, libraries);
  const embeddings = new EmbeddingsService(config),
    tokenizer = new TokenizerService(config),
    vectors = new InMemoryVectorStore();
  const parser = new DocumentParser(),
    docs = new DocumentsService(store, parser, libraries, tasks, config);
  const indexer = new IndexingService(
    store,
    parser,
    new RecursiveChunker(),
    embeddings,
    vectors,
    tasks,
    config,
  );
  const llm = new LlmService(config),
    models = new QualityModelsService(config),
    summary = new SummaryService(store, llm, tokenizer, config);
  const kb = await libraries.default(1),
    ids = new Map();
  const rows = [];
  const report = {
    status: 'running',
    annotationStatus: 'authored_requires_human_review',
    releaseGate: 'uncalibrated',
    model: config.get('EMBEDDING_MODEL'),
    dimensions: config.get('EMBEDDING_DIMENSIONS'),
    ranker: config.get('RERANK_MODEL') || 'gte-rerank-v2',
    runs: rows,
    aggregates: {},
  };
  const selectedSplit = process.argv.includes('--tune') ? 'tune' : 'acceptance';
  try {
    for (const d of documents) {
      let bytes = Buffer.from(d.text);
      if (d.kind === 'simple-table-pdf') {
        const PDFDocument = require('pdfkit'),
          pdf = new PDFDocument();
        bytes = await new Promise((resolve) => {
          const buffers = [];
          pdf.on('data', (b) => buffers.push(b));
          pdf.on('end', () => resolve(Buffer.concat(buffers)));
          pdf.font('Courier').fontSize(11).text(d.text);
          pdf.end();
        });
      }
      const accepted = await docs.ingest(bytes, d.filename, 1, { knowledgeBaseId: kb.id });
      await indexer.process(accepted.taskId);
      ids.set(d.id, accepted.documentId);
    }
    const chunks = await store.list('chunks');
    for (const strategy of ['vector', 'hybrid', 'hybrid-rerank']) {
      config.set('RAG_RETRIEVAL_STRATEGY', strategy);
      const rag = new RagService(embeddings, vectors, store, libraries, tokenizer, models, config);
      for (const item of cases.filter((c) => c.split === selectedSplit)) {
        const start = Date.now();
        try {
          const prepared = await rag.prepare(item.question, 1, kb.id, {
            documentIds: item.documentIds.map((id) => ids.get(id)),
            mode: item.mode,
            history: item.history,
          });
          const result = prepared.requiresAsync
            ? await summary.summarize(prepared.snapshot)
            : prepared.directAnswer
              ? { answer: prepared.directAnswer, citations: [] }
              : !prepared.sources.length
                ? { answer: NO_CONTEXT_ANSWER, citations: [] }
                : normalizeCitations(await llm.complete(prepared.prompt), prepared.sources);
          const expectedChunkIds = chunks
            .filter((c) =>
              item.evidence.some(
                (e) => ids.get(e.document) === c.documentId && c.text.includes(e.text),
              ),
            )
            .map((c) => c.id);
          const ranking =
            item.mode === 'overview'
              ? prepared.snapshot?.sources || prepared.sources
              : strategy === 'vector'
                ? prepared.diagnostics.candidates.vector
                : prepared.diagnostics.candidates.fused;
          const rankedIds = ranking.slice(0, 20).map((c) => c.id || c.chunkId);
          const positives = new Set(expectedChunkIds),
            recall = positives.size
              ? rankedIds.filter((id) => positives.has(id)).length / positives.size
              : null;
          const dcg = rankedIds.reduce(
            (n, id, i) => n + (positives.has(id) ? 1 / Math.log2(i + 2) : 0),
            0,
          );
          const ideal = Array.from(
            { length: Math.min(20, positives.size) },
            (_, i) => 1 / Math.log2(i + 2),
          ).reduce((a, b) => a + b, 0);
          rows.push({
            strategy,
            caseId: item.id,
            split: item.split,
            type: item.type,
            latencyMs: Date.now() - start,
            recallAt20: recall,
            ndcgAt20: ideal ? dcg / ideal : null,
            expectedEvidenceMapped: positives.size,
            answerPointCoverageHeuristic: item.expectedPoints.length
              ? item.expectedPoints.filter((point) => result.answer.includes(point)).length /
                item.expectedPoints.length
              : null,
            citationNumberValidity: result.citations.every(
              (c) =>
                prepared.sources.some((s) => s.chunkId === c.chunkId) ||
                prepared.snapshot?.sources.some((s) => s.chunkId === c.chunkId),
            ),
            abstentionHeuristic: item.expectedAbstention
              ? /不足|没有|无法|未提供|未找到/.test(result.answer)
              : null,
            correctness: null,
            completeness: null,
            citationSupport: null,
            humanReview: 'required',
            degraded: prepared.diagnostics.degraded,
            inputTokens: prepared.diagnostics.tokens.input,
            outputTokens: await tokenizer.count(result.answer, config.get('CHAT_TOKENIZER')),
            cost: {
              status: 'not_available',
              reason:
                'provider billing usage must be reconciled separately; local token counts are not billing amounts',
            },
            answer: result.answer,
            citations: result.citations,
          });
        } catch (error) {
          rows.push({
            strategy,
            caseId: item.id,
            status: 'error',
            error: error.message,
            latencyMs: Date.now() - start,
          });
        }
      }
    }
    for (const strategy of ['vector', 'hybrid', 'hybrid-rerank']) {
      const data = rows.filter((r) => r.strategy === strategy),
        mean = (key) => {
          const values = data.map((r) => r[key]).filter(Number.isFinite);
          return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        };
      const latencies = data.map((r) => r.latencyMs).sort((a, b) => a - b);
      report.aggregates[strategy] = {
        cases: data.length,
        errors: data.filter((r) => r.status === 'error').length,
        recallAt20: mean('recallAt20'),
        ndcgAt20: mean('ndcgAt20'),
        answerPointCoverageHeuristic: mean('answerPointCoverageHeuristic'),
        p95LatencyMs: latencies[Math.ceil(latencies.length * 0.95) - 1],
        correctness: null,
        citationSupport: null,
        releaseGate: 'requires_human_review_and_threshold_calibration',
      };
    }
    report.status = 'completed_requires_review';
  } finally {
    await embeddings.onModuleDestroy();
    await fs.rm(temp, { recursive: true, force: true });
    const output = path.resolve('.tmp/quality-evaluation-' + Date.now() + '.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify(
        { report: output, status: report.status, aggregates: report.aggregates },
        null,
        2,
      ),
    );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
