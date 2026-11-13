import PDFDocument from 'pdfkit';
import { pipeline } from './helpers/pipeline';
import { RetrievalService } from '../src/modules/rag/retrieval.service';
import { HistoryService } from '../src/modules/history/history.service';
import { normalizeCitations } from '../src/modules/rag/citations';
import { DocumentOriginalsService } from '../src/modules/documents/document-originals.service';
import { AgentService } from '../src/modules/agent/agent.service';
import { ChatService } from '../src/modules/chat/chat.service';
import { ChatController } from '../src/modules/chat/chat.controller';
import { agentLlmFixture } from './helpers/agent-llm.fixture';
import { EventEmitter } from 'node:events';

async function pdf(text: string) {
  const document = new PDFDocument();
  const pieces: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => {
    document.on('data', (piece) => pieces.push(piece));
    document.on('end', () => resolve(Buffer.concat(pieces)));
  });
  document.text(text);
  document.end();
  return bytes;
}

it('retains exact historical PDF anchors after replacement and retired chunk cleanup', async () => {
  const p = await pipeline();
  try {
    const uploaded = await p.documents.ingest(
      await pdf('Historical evidence in the original PDF.'),
      'evidence.pdf',
      1,
    );
    await p.indexing.process(uploaded.taskId);
    const retrieval = new RetrievalService(p.embeddings as any, p.vectors, p.store, p.libraries);
    const session = await retrieval.open(await retrieval.createScope(1, uploaded.knowledgeBaseId));
    const citation = { ...retrieval.citation(session, session.chunks[0]), number: 1 };
    expect(citation.location?.anchors?.length).toBeGreaterThan(0);
    const savedAnchors = structuredClone(citation.location!.anchors);
    const normalized = normalizeCitations('来自原件的回答[1]', [citation]);
    const history = new HistoryService(p.store, p.libraries);
    const chat = await history.create('旧版引用', 1, uploaded.knowledgeBaseId);
    await history.addMessage(chat.id, 1, 'assistant', normalized.answer, normalized.citations);

    const replacement = await p.documents.ingest(
      await pdf('A replacement with different content.'),
      'evidence.pdf',
      1,
      { documentId: uploaded.documentId, knowledgeBaseId: uploaded.knowledgeBaseId },
    );
    await p.indexing.process(replacement.taskId);
    const retired = (
      await p.store.list('tasks', { kind: 'retire', documentId: uploaded.documentId })
    )[0];
    await p.indexing.process(retired.id);
    expect(await p.store.get('chunks', citation.chunkId)).toBeUndefined();
    const result = await history.get(chat.id, 1);
    const snapshot = result.messages[0].citations[0];
    expect(snapshot).toMatchObject({
      sourceOutdated: true,
      sourceDeleted: false,
      versionId: citation.versionId,
    });
    expect(snapshot.location?.anchors).toEqual(savedAnchors);
    const originals = new DocumentOriginalsService(p.config, p.store);
    expect(
      (await originals.preview(1, uploaded.documentId, citation.versionId)).originalAvailable,
    ).toBe(true);
    expect((await originals.file(1, uploaded.documentId, citation.versionId)).size).toBeGreaterThan(
      0,
    );
    await p.documents.delete(uploaded.documentId, 1);
    expect((await history.get(chat.id, 1)).messages[0].citations[0].sourceDeleted).toBe(true);
    await expect(originals.file(1, uploaded.documentId, citation.versionId)).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    await p.cleanup();
  }
});

it('streams real retrieved PDF anchors and saves the same citation in chat history', async () => {
  const p = await pipeline();
  try {
    const uploaded = await p.documents.ingest(await pdf('Evidence from the original document.'), 'source.pdf', 1);
    await p.indexing.process(uploaded.taskId);
    const retrieval = new RetrievalService(p.embeddings as any, p.vectors, p.store, p.libraries);
    const llm = agentLlmFixture({
      complete: async () => '回答[1]',
      stream: async function* (prompt: string) {
        expect(prompt).not.toContain('anchors');
        yield '回答[1]';
      },
    });
    const agent = new AgentService(retrieval, llm as any, {} as any, p.config, p.store);
    const history = new HistoryService(p.store, p.libraries);
    const controller = new ChatController(new ChatService(agent, llm as any), history,
      { lookup: async () => null } as any);
    const response: any = new EventEmitter();
    let body = '';
    response.status = () => response;
    response.set = () => response;
    response.flushHeaders = () => {};
    response.write = (frame: string) => { body += frame; return true; };
    response.end = () => { response.writableEnded = true; };
    await controller.stream({ question: 'Evidence', knowledgeBaseId: uploaded.knowledgeBaseId }, 1, undefined, response);
    expect(body).not.toContain('event: error');
    const doneFrame = body.split('event: done\ndata: ')[1]?.split('\n\n')[0];
    expect(doneFrame).toBeDefined();
    const done = JSON.parse(doneFrame!);
    expect(done.citations[0].location.anchors.length).toBeGreaterThan(0);
    const saved = (await history.get(done.chatId, 1)).messages.find(m => m.role === 'assistant');
    expect(saved?.citations[0].location.anchors).toEqual(done.citations[0].location.anchors);
  } finally { await p.cleanup(); }
});
