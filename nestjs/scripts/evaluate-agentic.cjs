/* Isolated, synthetic-only comparison. Default mock is functional verification,
 * never a quality benchmark. This script does not build or touch dist. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const STRATEGIES = ['fixed', 'single-round', 'agentic', 'no-feedback'];

function argumentsFor(argv) {
  const options = { live: false, tune: false, limit: Infinity, buildDir: process.env.AGENT_EVAL_BUILD_DIR || '.data/agentic-build' };
  let mock = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--mock') mock = true;
    else if (arg === '--tune') options.tune = true;
    else if (arg === '--help') options.help = true;
    else if (['--limit', '--output', '--build-dir'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
      if (arg === '--limit') {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error('--limit must be a positive integer');
        options.limit = Number(value);
      } else options[arg === '--output' ? 'output' : 'buildDir'] = value;
    } else throw new Error('Unknown option: ' + arg);
  }
  if (mock && options.live) throw new Error('--mock and --live are mutually exclusive');
  return options;
}
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
const quality = () => ({ correctness: null, completeness: null, subtaskCoverage: null, citationSupport: null, abstentionAppropriateness: null });

// A deterministic simulator, deliberately independent of fixture answers/labels.
function mockModel(metrics) {
  async function observe(kind, input, execution = {}, operation) {
    execution.signal?.throwIfAborted();
    const request = { kind, input, model: 'functional-simulator', maxOutputTokens: execution.maxOutputTokens || 1024 };
    const reservation = await execution.observer?.before(request);
    metrics.calls.chat++;
    metrics.estimatedTokens += Buffer.byteLength(JSON.stringify(input), 'utf8') + request.maxOutputTokens;
    try {
      const result = operation();
      if (reservation !== undefined) await execution.observer.settle(reservation, { status: 'success' });
      return result;
    } catch (error) {
      if (reservation !== undefined) await execution.observer.settle(reservation, { status: 'error', error });
      throw error;
    }
  }
  const extract = prompt => {
    const body = prompt.match(/<(?:原文|资料)>\n([\s\S]*?)\n<\/(?:原文|资料)>/)?.[1] || prompt.split('\n原文：')[1] || '';
    const passages = [...body.matchAll(/\[(\d+)\][^\n]*\n([\s\S]*?)(?=\n\n\[\d+\]|$)/g)];
    return passages.length ? passages.slice(0, 4).map(m => m[2].trim().slice(0, 220) + ' [' + m[1] + ']').join('\n\n') : '当前模拟检索未获得可展示的证据，请补充资料。';
  };
  return {
    complete: (prompt, _key, _images, _signal, execution) => observe('complete', prompt, execution, () => {
      if (prompt.startsWith('分析用户问题')) {
        const question = prompt.split('问题：')[1]?.split('\n文件：')[0] || '';
        return JSON.stringify({ intent: /比较|对比|区别/.test(question) ? 'compare' : /总结|概览|全文|概括/.test(question) ? 'overview' : 'search', complexity: 'simple', subQuestions: [question], ambiguous: /^(它|这份文档|这个)[^？]*[？?]?$/.test(question) });
      }
      if (prompt.startsWith('检查原文')) {
        const subQuestions = JSON.parse(prompt.split('\n子问题：')[1].split('\n原文：')[0]);
        const originals = JSON.parse(prompt.split('\n原文：')[1]);
        const supported = originals.length > 0;
        return JSON.stringify({ supported, missing: supported ? [] : ['未找到证据'], conflicting: [], subQuestions: subQuestions.map(question => ({ question, status: supported ? 'supported' : 'missing', evidenceIds: originals.slice(0, 2).map(e => e.id) })) });
      }
      if (prompt.startsWith('核查')) return JSON.stringify({ supported: /\[\d+\]/.test(prompt) });
      return extract(prompt);
    }),
    invokeTools: (messages, _tools, execution) => observe('tools', messages, execution, () => {
      const context = JSON.parse(messages.find(m => m.role === 'user').content);
      const previous = messages.filter(m => m.role === 'tool');
      const docs = context.documents || [];
      let name, args;
      if (context.plan.intent === 'overview' && previous.length < docs.length) {
        name = 'summarize_document'; args = { documentId: docs[previous.length].documentId, question: context.question };
      } else if (previous.length === 0) {
        const exact = context.question.match(/\b(?:[A-Z]{1,5}-\d+|v\d+(?:\.\d+)+)\b/);
        name = exact ? 'keyword_search' : 'knowledge_search'; args = { query: exact ? exact[0] : context.question, limit: 8 };
      } else if (previous.length === 1 && context.plan.intent !== 'overview') {
        name = 'knowledge_search'; args = { query: context.question, limit: 8 };
      }
      return name ? { content: '', toolCalls: [{ id: 'mock-tool-' + previous.length, name, args }] } : { content: '申请依据检索资料作答', toolCalls: [] };
    }),
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  if (options.help) {
    console.log('evaluate-agentic.cjs [--mock|--live] [--tune] [--limit N] [--output report.json] [--build-dir .data/agentic-build]\nDefault: mock, acceptance split, no paid calls. Build: npx tsc -p tsconfig.json --outDir .data/agentic-build');
    return;
  }
  const build = path.resolve(__dirname, '..', options.buildDir);
  for (const file of ['config/configuration.js', 'modules/agent/agent.service.js', 'modules/rag/retrieval.service.js']) {
    try { await fs.access(path.join(build, file)); }
    catch { throw new Error('Missing isolated Agent evaluation build. From nestjs run: npx tsc -p tsconfig.json --outDir .data/agentic-build ; then npm run eval:agentic -- --mock. Override with --build-dir or AGENT_EVAL_BUILD_DIR.'); }
  }
  if (options.live) require('dotenv/config');
  require('reflect-metadata');
  const load = file => require(path.join(build, file));
  const { ConfigService } = require('@nestjs/config');
  const { validateConfig } = load('config/configuration');
  const root = path.resolve(__dirname, '../../docs/evaluation');
  const read = async file => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
  const documents = await read('accuracy/documents.json');
  const fixtures = [...await read('accuracy/cases.json'), ...await read('agentic/cases.json')];
  const split = options.tune ? 'tune' : 'acceptance';
  const selected = fixtures.filter(c => c.split === split).slice(0, options.limit);
  const metrics = { calls: { chat: 0, planner: 0, rerank: 0, embedding: 0, embeddingQuery: 0 }, estimatedTokens: 0, providerUsage: [] };
  const snapshotMetrics = () => structuredClone(metrics);
  const diffMetrics = before => ({ calls: Object.fromEntries(Object.keys(metrics.calls).map(k => [k, metrics.calls[k] - before.calls[k]])), estimatedTokens: metrics.estimatedTokens - before.estimatedTokens, providerUsage: metrics.providerUsage.slice(before.providerUsage.length) });
  const originalFetch = global.fetch;
  // In mock mode even accidental newly introduced HTTP calls fail closed.
  global.fetch = options.live ? async (...args) => {
    const response = await originalFetch(...args);
    try {
      const body = await response.clone().json();
      const usage = body.usage || body.output?.usage;
      metrics.providerUsage.push({ endpoint: new URL(String(args[0])).pathname, status: response.status, usage: usage || null });
    } catch { metrics.providerUsage.push({ status: response.status, usage: null }); }
    return response;
  } : async () => { throw new Error('External HTTP disabled in functional mock evaluation'); };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-agentic-eval-'));
  let embeddings;
  const report = {
    schemaVersion: 1, status: 'running', mode: options.live ? 'live' : 'mock', scope: options.live ? 'synthetic_quality_requires_human_review' : 'functional_only',
    split, dataset: { documents: documents.length, originalCases: 60, addedCases: 40, selectedCases: selected.length, sha256: crypto.createHash('sha256').update(JSON.stringify({ documents, fixtures })).digest('hex') },
    annotationStatus: 'authored_requires_human_review', humanReview: 'required', releaseGate: 'not_accepted',
    quality: quality(), cost: { status: 'unknown', amount: null, reason: 'Provider usage is recorded separately; no billing reconciliation or price assumptions.' },
    cache: { policy: 'one shared immutable index; summary cache cleared before every case; in-process lexical cache may be warm', temperature: 'mixed_not_a_cold_warm_benchmark' },
    buildDir: build, runs: [], aggregates: {},
  };
  const output = path.resolve(options.output || path.join(__dirname, '../.data/agentic-evaluation-' + split + '-' + Date.now() + '.json'));
  try {
    const input = options.live ? { ...process.env } : {};
    if (options.live) {
      for (const key of ['CHAT_API_KEY', 'EMBEDDING_API_KEY', 'CHAT_TOKENIZER', 'EMBEDDING_TOKENIZER'])
        if (!input[key]) throw new Error('Missing ' + key + ' for --live');
      for (const key of ['CHAT_TOKENIZER', 'EMBEDDING_TOKENIZER']) {
        if (input[key].startsWith('test:') || (!input[key].startsWith('estimate:') && !path.isAbsolute(input[key]))) throw new Error(key + ' must be an explicit conservative estimate or verified absolute local tokenizer path');
      }
    }
    // Production retrieval gates planning/reranking on STORAGE_DRIVER != memory.
    // Only service behavior uses this flag: the concrete store/vector instances below
    // are always memory. No application module, SQL client or Qdrant client is started.
    const config = new ConfigService(validateConfig({ ...input, STORAGE_DRIVER: 'mysql', DB_USER: 'unused', DB_PASSWORD: 'unused', VECTOR_DRIVER: 'memory', QUEUE_DRIVER: 'memory', JWT_SECRET: 'synthetic-agentic-evaluation-secret-32-characters', ORIGINALS_DIR: temp, UPLOAD_TEMP_DIR: path.join(temp, 'uploads'), PAGE_ASSETS_DIR: path.join(temp, 'pages'), PDF_ANALYSIS_MODE: 'legacy', VISION_ENABLED: false, EMBEDDING_PROVIDER: options.live ? 'dashscope' : 'local', ...(!options.live ? { EMBEDDING_TOKENIZER: 'estimate:utf8-v1', CHAT_TOKENIZER: 'estimate:utf8-v1' } : {}), RAG_RETRIEVAL_STRATEGY: 'hybrid-rerank' }));
    report.storage = { business: 'MemoryStore', vectors: 'InMemoryVectorStore', originals: 'ephemeral synthetic files only', productionRetrievalGatesEnabled: true };
    report.configuration = Object.fromEntries(['CHAT_MODEL', 'AGENT_MODEL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'EMBEDDING_TOKENIZER', 'CHAT_TOKENIZER', 'RERANK_MODEL', 'AGENT_DECISIONS', 'AGENT_TOOLS', 'AGENT_TOOL_CONCURRENCY', 'AGENT_ASSESSMENTS', 'AGENT_MODEL_CALLS', 'AGENT_TOKEN_BUDGET', 'AGENT_ACTIVE_MS', 'AGENT_SYNC_MS', 'AGENT_TOOL_TOKENS', 'RAG_EVIDENCE_TOKENS'].map(k => [k, config.get(k)]));
    const { MemoryStore } = load('persistence/memory.store');
    const { KnowledgeBasesService } = load('modules/knowledge-bases/knowledge-bases.service');
    const { TasksService } = load('modules/tasks/tasks.service');
    const { DocumentsService } = load('modules/documents/documents.service');
    const { DocumentParser } = load('modules/documents/parsers/document.parser');
    const { IndexingService } = load('modules/documents/indexing.service');
    const { RecursiveChunker } = load('modules/documents/chunkers/recursive.chunker');
    const { EmbeddingsService } = load('modules/embeddings/embeddings.service');
    const { TokenizerService } = load('modules/embeddings/tokenizer.service');
    const { InMemoryVectorStore } = load('modules/vector-store/in-memory-vector-store.service');
    const { QualityModelsService } = load('modules/rag/quality-models.service');
    const { RetrievalService } = load('modules/rag/retrieval.service');
    const { RagService } = load('modules/rag/rag.service');
    const { SummaryService } = load('modules/rag/summary.service');
    const { AgentService } = load('modules/agent/agent.service');
    const { LlmService } = load('modules/llm/llm.service');
    const { normalizeCitations, NO_CONTEXT_ANSWER } = load('modules/rag/citations');
    const { tokenize } = load('modules/rag/retrieval-algorithms');
    const store = new MemoryStore(), libraries = new KnowledgeBasesService(store), tasks = new TasksService(store, libraries);
    embeddings = new EmbeddingsService(config);
    if (!options.live) {
      embeddings.embedDocuments = async (texts, profile = embeddings.currentProfile()) => texts.map(text => {
        const vector = new Array(profile.dimensions).fill(0);
        for (const term of tokenize(text)) vector[crypto.createHash('sha256').update(term).digest().readUInt32LE(0) % vector.length]++;
        const norm = Math.hypot(...vector) || 1;
        return vector.map(x => x / norm);
      });
      embeddings.embedQuery = async (text, profile) => (await embeddings.embedDocuments([text], profile))[0];
    }
    const tokenizer = new TokenizerService(config), vectors = new InMemoryVectorStore(), parser = new DocumentParser();
    // Validate tokenizer installation before the first live embedding request.
    await tokenizer.count('tokenizer preflight', config.get('CHAT_TOKENIZER'));
    await tokenizer.count('tokenizer preflight', config.get('EMBEDDING_TOKENIZER'));
    const models = options.live ? new QualityModelsService(config) : {
      plan: async (question, _history, docs) => ({ query: question, keywords: tokenize(question), mode: /总结|概览|全文/.test(question) ? 'overview' : /比较|对比/.test(question) ? 'compare' : 'search', documentIds: docs.map(d => d.id), ambiguous: false, route: 'document' }),
      rerank: async (question, texts) => texts.map((text, index) => ({ index, score: tokenize(question).filter(t => text.toLowerCase().includes(t)).length / Math.max(1, tokenize(question).length) })).sort((a, b) => b.score - a.score),
    };
    const instrument = (object, method, key) => { const original = object[method].bind(object); object[method] = (...args) => { metrics.calls[key]++; return original(...args); }; };
    instrument(embeddings, 'embedDocuments', 'embedding'); instrument(embeddings, 'embedQuery', 'embeddingQuery');
    instrument(models, 'plan', 'planner'); instrument(models, 'rerank', 'rerank');
    const llm = options.live ? new LlmService(config) : mockModel(metrics);
    if (options.live) {
      for (const method of ['complete', 'invokeTools']) {
        const original = llm[method].bind(llm);
        llm[method] = (...args) => {
          const index = method === 'complete' ? 4 : 2;
          const execution = args[index] || {}, observer = execution.observer;
          args[index] = { ...execution, observer: {
            before: async request => {
              const reservation = observer ? await observer.before(request) : 'evaluation-only';
              metrics.calls.chat++;
              metrics.estimatedTokens += Buffer.byteLength(JSON.stringify(request.input), 'utf8') + request.maxOutputTokens;
              return reservation;
            },
            settle: async (reservation, outcome) => { await observer?.settle(reservation, outcome); },
          } };
          return original(...args);
        };
      }
    }
    const summary = new SummaryService(store, llm, tokenizer, config);
    const retrieval = new RetrievalService(embeddings, vectors, store, libraries, tokenizer, models, config);
    const rag = new RagService(embeddings, vectors, store, libraries, tokenizer, models, config, retrieval);
    const agent = new AgentService(retrieval, llm, summary, config, store);
    const docs = new DocumentsService(store, parser, libraries, tasks, config);
    const indexer = new IndexingService(store, parser, new RecursiveChunker(), embeddings, vectors, tasks, config);
    const kb = await libraries.default(1), ids = new Map();
    const indexStart = snapshotMetrics();
    for (const doc of documents) {
      let bytes = Buffer.from(doc.text);
      if (doc.kind === 'simple-table-pdf') {
        const PDFDocument = require('pdfkit'), pdf = new PDFDocument();
        bytes = await new Promise(resolve => { const buffers = []; pdf.on('data', b => buffers.push(b)); pdf.on('end', () => resolve(Buffer.concat(buffers))); pdf.font('Courier').fontSize(11).text(doc.text); pdf.end(); });
      }
      const accepted = await docs.ingest(bytes, doc.filename, 1, { knowledgeBaseId: kb.id });
      await indexer.process(accepted.taskId);
      const task = await store.get('tasks', accepted.taskId);
      if (task?.status !== 'completed') throw new Error('Synthetic index failed: ' + doc.filename + ' ' + task?.status + ' ' + (task?.error || ''));
      ids.set(doc.id, accepted.documentId);
    }
    report.indexing = { ...diffMetrics(indexStart), revisions: (await store.list('documents')).map(d => ({ filename: d.filename, indexRevisionId: d.activeIndexRevisionId })) };
    for (const strategy of STRATEGIES) {
      for (const fixture of selected) {
        // Only these input fields may reach generators; review labels stay outside.
        const item = { id: fixture.id, question: fixture.question, documentIds: fixture.documentIds.map(id => ids.get(id)), mode: fixture.mode, history: fixture.history || [] };
        for (const cached of await store.list('summaryCaches')) await store.delete('summaryCaches', cached.id);
        const started = performance.now(), before = snapshotMetrics();
        const row = { strategy, caseId: item.id, split, type: fixture.type, status: 'running', humanReview: 'required', quality: quality(), firstBodyMs: null };
        let context, checkpoint;
        try {
          if (item.documentIds.some(id => !id)) throw new Error('Unknown synthetic document ID');
          const preparation = { documentIds: item.documentIds, mode: item.mode, history: item.history };
          if (strategy === 'fixed') {
            context = await rag.prepare(item.question, 1, kb.id, preparation);
            const answer = context.requiresAsync ? await summary.summarize(context.snapshot) : context.directAnswer ? { answer: context.directAnswer, citations: [] } : !context.sources.length ? { answer: NO_CONTEXT_ANSWER, citations: [] } : normalizeCitations(await llm.complete(context.prompt), context.sources);
            row.answer = answer.answer; row.citations = answer.citations;
          } else {
            const evaluation = strategy === 'agentic' ? undefined : strategy;
            const onCheckpoint = async snapshot => { checkpoint = snapshot; };
            context = await agent.prepare(item.question, 1, kb.id, { ...preparation, evaluation, onCheckpoint });
            let resumes = 0;
            while (context.requiresAsync) {
              if (++resumes > 4) throw new Error('Agent continuation did not finish');
              context = await agent.resume(context.agentSnapshot || context.snapshot, { ...preparation, evaluation, onCheckpoint, background: true });
            }
            const answer = await agent.answerPrepared(context);
            row.answer = answer.answer; row.citations = answer.citations;
            row.agentBudget = context.agentSnapshot.budget;
            row.steps = context.diagnostics.agent.steps; row.stopReason = context.diagnostics.agent.stopReason || 'ready';
          }
          row.sources = context.sources;
          row.degraded = context.diagnostics?.degraded || [];
          row.status = 'completed';
        } catch (error) {
          row.status = 'error'; row.error = { name: error.name, message: error.message };
          if (checkpoint || context?.agentSnapshot) {
            const state = checkpoint || context.agentSnapshot;
            row.agentBudget = state.budget; row.steps = state.steps; row.stopReason = state.stopReason || 'error';
          }
        }
        row.latencyMs = performance.now() - started;
        row.telemetry = diffMetrics(before);
        row.toolCalls = row.steps?.filter(step => step.kind === 'tool_start').length || 0;
        row.estimatedAnswerTokens = row.answer ? await tokenizer.count(row.answer, config.get('CHAT_TOKENIZER')) : 0;
        report.runs.push(row);
      }
    }
    for (const strategy of STRATEGIES) {
      const rows = report.runs.filter(row => row.strategy === strategy);
      report.aggregates[strategy] = { cases: rows.length, completed: rows.filter(r => r.status === 'completed').length, errors: rows.filter(r => r.status === 'error').length, p50LatencyMs: percentile(rows.map(r => r.latencyMs), .5), p95LatencyMs: percentile(rows.map(r => r.latencyMs), .95), firstBodyLatencyMs: null, modelCalls: rows.reduce((n, r) => n + r.telemetry.calls.chat + r.telemetry.calls.planner + r.telemetry.calls.rerank, 0), toolCalls: rows.reduce((n, r) => n + r.toolCalls, 0), quality: quality() };
    }
    const hasErrors = report.runs.some(row => row.status === 'error');
    report.status = hasErrors ? (options.live ? 'completed_with_errors_requires_human_review' : 'completed_with_errors_functional_only') : options.live ? 'completed_requires_human_review' : 'completed_functional_only';
  } catch (error) { report.status = 'setup_failed'; report.error = { name: error.name, message: error.message }; process.exitCode = 1; }
  finally {
    global.fetch = originalFetch;
    await embeddings?.onModuleDestroy();
    await fs.rm(temp, { recursive: true, force: true });
    report.telemetry = { ...snapshotMetrics(), providerUsageStatus: options.live ? 'recorded_when_returned_else_unknown' : 'not_applicable_simulated', estimateMeaning: 'Conservative local reservation estimates; not provider usage or billing.' };
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: output, status: report.status, scope: report.scope, error: report.error, aggregates: report.aggregates }, null, 2));
    if (report.runs.some(row => row.status === 'error')) process.exitCode = 1;
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { argumentsFor, mockModel, percentile };
