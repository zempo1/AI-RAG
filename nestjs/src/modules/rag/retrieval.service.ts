/** Shared original-evidence retrieval. Never invokes the baseline orchestration. */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { assertEmbeddingCompatible, legacyModelProfile } from '../embeddings/model-profile';
import { TokenizerService } from '../embeddings/tokenizer.service';
import { VectorStore } from '../vector-store/vector-store.interface';
import { KnowledgeBasesService } from '../knowledge-bases/knowledge-bases.service';
import { Store, Row } from '../../persistence/store';
import { ApiError } from '../../common/api-error';
import { Citation } from './citations';
import { pdfReadingContext } from './pdf-reading-context';
import { splitPdfCitation } from './pdf-citation-segments';
import { structuralPdfCitations } from './pdf-structural-citations';
import { sliceSourceLocation } from '../documents/parsers/source-anchors';
import { LexicalIndex, searchLexical, fuse, Scored } from './retrieval-algorithms';
import { QualityModelsService } from './quality-models.service';
import { RetrievalScope, RetrievalSession, SearchOptions, SearchResult, ReadRange, OriginalEvidence } from './retrieval.types';

@Injectable()
export class RetrievalService {
  private readonly lexicalCache = new Map<number, LexicalIndex>();
  constructor(
    private readonly embeddings: EmbeddingsService,
    private readonly vectors: VectorStore,
    private readonly store: Store,
    private readonly libraries: KnowledgeBasesService,
    @Optional() private readonly tokenizer?: TokenizerService,
    @Optional() private readonly models?: QualityModelsService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async createScope(userId: number, knowledgeBaseId?: number, documentIds?: number[]): Promise<RetrievalScope> {
    const kb = await this.libraries.resolve(userId, knowledgeBaseId);
    const docs = (await this.store.list('documents', { userId, knowledgeBaseId: kb.id })).filter(d => !d.deletedAt && d.activeIndexRevisionId);
    const ids = documentIds?.length ? [...new Set(documentIds)] : undefined;
    const selected = ids ? docs.filter(d => ids.includes(Number(d.id))) : docs;
    if (ids && selected.length !== ids.length) throw new ApiError(404, '所选文件不存在、未就绪或不属于当前知识库');
    return { userId, knowledgeBaseId: kb.id, documents: selected.map(d => ({ documentId: d.id, filename: d.filename, indexRevisionId: d.activeIndexRevisionId })) };
  }

  async verify(scope: RetrievalScope, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.libraries.owned(scope.knowledgeBaseId, scope.userId);
    for (const expected of scope.documents) {
      const doc = await this.store.get('documents', expected.documentId);
      if (!doc || doc.deletedAt || doc.userId !== scope.userId || doc.knowledgeBaseId !== scope.knowledgeBaseId)
        throw new ApiError(404, '文档授权已失效');
      if (doc.activeIndexRevisionId !== expected.indexRevisionId) throw new ApiError(409, '文档索引已更新，请重新提问');
      const revision = await this.store.get('indexRevisions', expected.indexRevisionId);
      if (!revision || (revision.documentId != null && revision.documentId !== doc.id))
        throw new ApiError(409, '文档索引已清理，请重新提问');
    }
    signal?.throwIfAborted();
  }

  async open(scope: RetrievalScope, documentIds?: number[], signal?: AbortSignal): Promise<RetrievalSession> {
    await this.verify(scope, signal);
    const ids = documentIds?.length ? [...new Set(documentIds)] : scope.documents.map(d => d.documentId);
    if (ids.some(id => !scope.documents.some(d => d.documentId === id))) throw new ApiError(404, '文件超出固定授权范围');
    const documents: Row[] = [], chunks: Row[] = [], revisions = new Map<number, Row>();
    for (const id of ids) {
      const expected = scope.documents.find(d => d.documentId === id)!;
      const doc = (await this.store.get('documents', id))!;
      documents.push(doc);
      revisions.set(expected.indexRevisionId, (await this.store.get('indexRevisions', expected.indexRevisionId))!);
      chunks.push(...(await this.store.list('chunks', { indexRevisionId: expected.indexRevisionId })).filter(c => c.documentId === id && c.indexRevisionId === expected.indexRevisionId).sort((a,b) => a.chunkIndex-b.chunkIndex));
    }
    await this.verify(scope, signal);
    return { scope: structuredClone(scope), documents, chunks, revisions, byChunk: new Map(chunks.map(c => [c.id,c])), byDoc: new Map(documents.map(d => [d.id,d])) };
  }

  private lexical(session: RetrievalSession, query: string): Scored[] {
    const indexes: LexicalIndex[] = [];
    for (const revisionId of session.revisions.keys()) {
      let index = this.lexicalCache.get(revisionId);
      if (!index) {
        index = new LexicalIndex(session.chunks.filter(c => c.indexRevisionId === revisionId).map(c => ({ id: c.id, text: c.retrievalMetadata?.embeddingText || c.text, terms: c.retrievalMetadata?.terms })));
        this.lexicalCache.set(revisionId, index);
      }
      indexes.push(index);
    }
    if (this.lexicalCache.size > 64) this.lexicalCache.delete(this.lexicalCache.keys().next().value!);
    return searchLexical(query, indexes, new Set(session.chunks.map(c => c.id))).slice(0,40);
  }

  private async vector(session: RetrievalSession, query: string, signal?: AbortSignal): Promise<Scored[]> {
    const groups = new Map<string, { profile: any; ids: number[] }>();
    for (const [id, revision] of session.revisions) {
      const profile = revision.modelProfile || legacyModelProfile();
      const key = JSON.stringify(profile);
      const group = groups.get(key) || { profile, ids: [] };
      group.ids.push(id); groups.set(key, group);
    }
    const lists: Scored[][] = [];
    for (const group of groups.values()) {
      signal?.throwIfAborted();
      const v = await this.embeddings.embedQuery(query, group.profile, signal);
      const hits = await this.vectors.search(v, 40, 0.5, { userId: session.scope.userId, knowledgeBaseId: session.scope.knowledgeBaseId, indexRevisionIds: group.ids, modelProfile: group.profile });
      signal?.throwIfAborted();
      lists.push(hits.filter(m => {
        const c = session.byChunk.get(m.segment.chunkId!);
        return c && c.documentId === m.segment.documentId && c.indexRevisionId === m.segment.indexRevisionId;
      }).map(m => ({ id: m.segment.chunkId!, score: m.score })));
    }
    return groups.size === 1 ? lists[0] : fuse(...lists).slice(0,40);
  }

  async search(session: RetrievalSession, query: string, options: SearchOptions = {}): Promise<SearchResult> {
    await this.verify(session.scope, options.signal);
    // General chat and reading original text need no vectors. Check only the actual
    // search selection, before allSettled/fallback can turn an incompatible index into silence.
    if (this.config) for (const revision of session.revisions.values())
      assertEmbeddingCompatible(revision.modelProfile || legacyModelProfile(), this.config);
    const strategy = options.strategy || 'hybrid-rerank';
    let lexical: Scored[] = [], vector: Scored[] = [];
    const degraded: string[] = [];
    const outcomes = await Promise.allSettled([
      strategy === 'vector' ? Promise.resolve([]) : Promise.resolve().then(() => this.lexical(session, options.lexicalQuery || query)),
      strategy === 'keyword' ? Promise.resolve([]) : this.vector(session, query, options.signal),
    ]);
    options.signal?.throwIfAborted();
    if (outcomes[0].status === 'fulfilled') lexical = outcomes[0].value; else degraded.push('lexical_failed');
    if (outcomes[1].status === 'fulfilled') vector = outcomes[1].value || []; else degraded.push('vector_failed');
    if (degraded.length === 2 || (strategy === 'keyword' && degraded.includes('lexical_failed')) || (strategy === 'vector' && degraded.includes('vector_failed')))
      throw new ApiError(503, '检索服务暂时不可用，请稍后重试');
    let candidates = strategy === 'keyword' ? lexical : strategy === 'vector' ? vector.slice(0,5) : fuse(vector, lexical).slice(0,50);
    const fused = candidates;
    if (strategy === 'hybrid-rerank' && candidates.length && this.models && this.config?.get('STORAGE_DRIVER') !== 'memory') {
      try {
        options.onProgress?.('reranking');
        const ranking = await this.models.rerank(query, candidates.map(c => { const row = session.byChunk.get(c.id)!; return row.retrievalMetadata?.embeddingText || row.text; }), options.signal);
        candidates = ranking.filter(r => r.score >= Number(this.config?.get('RERANK_MIN_SCORE') || 0)).map(r => ({ id: candidates[r.index].id, score: r.score }));
      } catch (error) { options.signal?.throwIfAborted(); degraded.push('rerank_failed_rrf_fallback'); }
    }
    await this.verify(session.scope, options.signal);
    const limit = Math.max(1, Math.min(20, options.limit ?? 8));
    return { candidates, evidence: this.expand(session, candidates.slice(0,limit), strategy !== 'vector'), channels: { lexical, vector, fused, reranked: candidates }, degraded };
  }

  citation(session: RetrievalSession, chunk: Row, score = 0): Citation {
    if (!session.byChunk.has(chunk.id)) throw new ApiError(404, '片段超出授权范围');
    return { number: 0, documentId: chunk.documentId, knowledgeBaseId: session.scope.knowledgeBaseId, versionId: chunk.versionId, indexRevisionId: chunk.indexRevisionId, chunkId: chunk.id, filename: session.byDoc.get(chunk.documentId)!.filename, text: chunk.text, location: chunk.location || null, score };
  }

  original(source: Citation): OriginalEvidence {
    const identity = JSON.stringify([source.documentId, source.indexRevisionId, source.chunkIds || [source.chunkId], source.location, source.text]);
    return { ...source, evidenceId: 'ev_' + createHash('sha256').update(identity).digest('hex').slice(0,32) };
  }

  expand(session: RetrievalSession, candidates: Scored[], expandContext = true, all = false): OriginalEvidence[] {
    const { chunks, byChunk } = session;
    const citation = (chunk: Row, score: number) => this.citation(session, chunk, score);
    let evidence: Citation[] = [];
    const included = new Set<number>();
    const add = (row: Row, score: number) => {
      if (included.has(row.id)) return;
      included.add(row.id);
      evidence.push(citation(row, score));
    };
    if (all) chunks.forEach((c) => add(c, 0));
    else {
      let chosen = candidates;
      for (const match of chosen) {
        const chunk = byChunk.get(match.id)!;
        if (!expandContext) {
          add(chunk, match.score);
          continue;
        }
        const meta = chunk.retrievalMetadata;
        // 子块命中后优先补充父块；旧片段无父块信息时补相邻片段，降低上下文缺失。
        if (meta?.parentId) {
          const parent = chunks.filter(
            (c) =>
              c.documentId === chunk.documentId &&
              c.indexRevisionId === chunk.indexRevisionId &&
              c.retrievalMetadata?.parentId === meta.parentId,
          );
          if (
            !parent.every((c) => included.has(c.id)) &&
            typeof meta.parentText === 'string' &&
            meta.parentLocation
          ) {
            parent.forEach((c) => included.add(c.id));
            evidence.push({
              ...citation(chunk, match.score),
              text: meta.parentText,
              location: meta.parentLocation,
              chunkIds: parent.map((c) => c.id),
            });
          } else parent.forEach((c) => add(c, match.score));
        } else
          chunks
            .filter(
              (c) =>
                c.documentId === chunk.documentId && Math.abs(c.chunkIndex - chunk.chunkIndex) <= 1,
            )
            .forEach((c) => add(c, match.score));
      }
    }
    // 图片描述的上下文作为独立原文证据展开，避免给合成文字伪造连续偏移。
    for (const source of [...evidence]) {
      if (!source.location?.regionImage) continue;
      const visual = chunks.find((c) => c.id === source.chunkId);
      const ranges = visual?.retrievalMetadata?.contextRanges;
      if (!Array.isArray(ranges)) continue;
      for (const chunk of chunks) {
        if (
          chunk.documentId !== source.documentId ||
          chunk.indexRevisionId !== source.indexRevisionId ||
          chunk.location?.contentType !== 'native' ||
          chunk.location?.page !== source.location.page
        )
          continue;
        for (const range of ranges) {
          const start = Math.max(chunk.location.start, range.start),
            end = Math.min(chunk.location.end, range.end);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) continue;
          evidence.push({
            ...citation(chunk, source.score),
            text: chunk.text.slice(start - chunk.location.start, end - chunk.location.start),
            location: sliceSourceLocation(chunk.location, start, end),
          });
        }
      }
    }
    // Keep exact raw citations; deduplicate overlapping source ranges instead of synthesizing new text.
    evidence = evidence.filter(
      (s, i, all) =>
        !all
          .slice(0, i)
          .some(
            (p) =>
              p.documentId === s.documentId &&
              p.indexRevisionId === s.indexRevisionId &&
              p.location &&
              s.location &&
              p.location.page === s.location.page && p.location.contentType === s.location.contentType && p.location.regionImage === s.location.regionImage && p.location.start <= s.location.start &&
              p.location.end >= s.location.end,
          ),
    );

    return evidence.map(source => this.original(source));
  }

  async read(session: RetrievalSession, range: ReadRange, signal?: AbortSignal) {
    await this.verify(session.scope, signal);
    if (!session.byDoc.has(range.documentId)) throw new ApiError(404, '文件超出固定授权范围');
    if ([range.cursor, range.pageStart, range.pageEnd, range.limit].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0)) || (range.pageStart !== undefined && range.pageEnd !== undefined && range.pageEnd < range.pageStart)) throw new ApiError(400, '非法读取范围');
    const rows = session.chunks.filter(c => c.documentId === range.documentId && (range.pageStart === undefined || c.location?.page >= range.pageStart) && (range.pageEnd === undefined || c.location?.page <= range.pageEnd) && (range.heading === undefined || c.location?.heading === range.heading));
    const cursor = range.cursor || 0, limit = Math.max(1,Math.min(100,range.limit ?? 20));
    const selected = rows.slice(cursor,cursor+limit);
    const complete = cursor + selected.length >= rows.length;
    return { evidence: selected.map(c => this.original(this.citation(session,c))), complete, total: rows.length, nextCursor: complete ? undefined : cursor+selected.length };
  }

  context(sources: Citation[], options?: { readingOrder?: boolean }) {
    if (options?.readingOrder && !sources.some(s => s.sourceSegments)) {
      const ordered = pdfReadingContext(sources);
      if (ordered) return ordered;
    }
    const note = sources.some(s => s.sourceSegments) && sources.some(s => s.location?.anchors?.some(a => a.kind !== 'native'))
      ? '原生文字段落优先；识别补充与原生文字冲突时以原生文字为准。\n' : '';
    return note + sources.map(s => '['+s.number+'] 文件：'+s.filename+(s.location?.page ? ' 第'+s.location.page+'页' : '')+
      (s.sectionTitle ? ' · '+s.sectionTitle : '')+'\n'+s.text).join('\n\n');
  }

  citationEvidence(evidence: OriginalEvidence[]) {
    const originals = new Set(evidence);
    return structuralPdfCitations(evidence).flatMap(source => (source.sourceSegments ? [source] : splitPdfCitation(source))
      .map(part => originals.has(part) ? part : this.original(part)));
  }

  async pack(evidence: OriginalEvidence[], budget: number, options?: { readingOrder?: boolean }) {
    const segments = this.citationEvidence(evidence);
    const sources: OriginalEvidence[] = [];
    let tokens = 0;
    for (const source of segments) {
      const candidate = [...sources, { ...source, number: sources.length+1 }];
      const text = this.context(candidate, options);
      const count = this.tokenizer ? await this.tokenizer.count(text,this.config?.get('CHAT_TOKENIZER')) : Array.from(text).length;
      if (count <= Math.max(0,budget)) { sources.push(candidate.at(-1)!); tokens = count; }
    }
    return { sources, tokens, complete: sources.length === segments.length };
  }
}
