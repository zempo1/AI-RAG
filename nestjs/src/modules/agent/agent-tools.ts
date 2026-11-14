import { ConfigService } from '@nestjs/config';
import { sliceSourceLocation } from '../documents/parsers/source-anchors';
import { RetrievalService } from '../rag/retrieval.service';
import { SummaryService } from '../rag/summary.service';
import { ToolCall, ToolDefinition, ModelExecutionOptions } from '../llm/llm.types';
import { AgentSnapshot, AgentOptions } from './agent.types';
import type { OriginalEvidence } from '../rag/retrieval.types';

export const names = [
  'list_documents',
  'knowledge_search',
  'keyword_search',
  'read_document',
  'summarize_document',
] as const;
const descriptions: Record<string, string> = {
  list_documents: '列出授权文档，按文件名过滤并分页。',
  knowledge_search: '对问题进行语义和关键词混合检索，可缩小文档范围。',
  keyword_search: '精确关键词检索，适合名称、代码和原句。',
  read_document: '按页、章节和游标读取原文，可用 offset 续读大块。',
  summarize_document: '对单个文档或章节进行完整分组摘要并核对原文。',
};
export const definitions: ToolDefinition[] = names.map((name) => ({
  type: 'function',
  function: {
    name,
    description: descriptions[name],
    parameters: {
      type: 'object',
      properties:
        name === 'list_documents'
          ? { filter: { type: 'string' }, cursor: { type: 'integer' }, limit: { type: 'integer' } }
          : name.includes('search')
            ? {
                query: { type: 'string' },
                documentIds: { type: 'array', items: { type: 'integer' } },
                limit: { type: 'integer' },
              }
            : {
                documentId: { type: 'integer' },
                pageStart: { type: 'integer' },
                pageEnd: { type: 'integer' },
                heading: { type: 'string' },
                cursor: { type: 'integer' },
                offset: { type: 'integer' },
                question: { type: 'string' },
              },
      required: name.includes('search')
        ? ['query']
        : name === 'list_documents'
          ? []
          : ['documentId'],
      additionalProperties: false,
    },
  },
}));

/** Pure read-only tool adapters. The runtime owns scheduling, state commits and model budgets. */
export class AgentTools {
  constructor(
    private readonly retrieval: RetrievalService,
    private readonly summary: SummaryService,
    private readonly config: ConfigService,
    private readonly execution: (s: AgentSnapshot, o: AgentOptions) => ModelExecutionOptions,
    private readonly canAnswerDirectly?: (s: AgentSnapshot, call: ToolCall, evidence: OriginalEvidence[]) => Promise<boolean>,
  ) {}
  private limit(key: string, fallback: number) {
    return Number(this.config.get(key)) || fallback;
  }
  validate(call: ToolCall, s: AgentSnapshot) {
    if (
      !names.includes(call.name as any) ||
      !call.args ||
      typeof call.args !== 'object' ||
      Array.isArray(call.args)
    )
      throw new Error('非法工具');
    const allowed =
      call.name === 'list_documents'
        ? ['filter', 'cursor', 'limit']
        : call.name.includes('search')
          ? ['query', 'documentIds', 'limit']
          : ['documentId', 'pageStart', 'pageEnd', 'heading', 'cursor', 'offset', 'question'];
    if (Object.keys(call.args).some((k) => !allowed.includes(k))) throw new Error('非法工具参数');
    const a: any = call.args;
    if (call.name.includes('search') && (typeof a.query !== 'string' || !a.query.trim()))
      throw new Error('非法检索词');
    if (
      a.documentId !== undefined &&
      (!Number.isSafeInteger(a.documentId) ||
        !s.scope.documents.some((d) => d.documentId === a.documentId))
    )
      throw new Error('文档超出授权范围');
    if (
      !call.name.includes('search') &&
      call.name !== 'list_documents' &&
      a.documentId === undefined
    )
      throw new Error('缺少文档');
    if (
      a.documentIds !== undefined &&
      (!Array.isArray(a.documentIds) ||
        a.documentIds.some(
          (id: any) =>
            !Number.isSafeInteger(id) || !s.scope.documents.some((d) => d.documentId === id),
        ))
    )
      throw new Error('文档超出授权范围');
    for (const k of ['limit', 'cursor', 'offset', 'pageStart', 'pageEnd'])
      if (a[k] !== undefined && (!Number.isSafeInteger(a[k]) || a[k] < 0))
        throw new Error('非法范围');
    if (
      (a.heading !== undefined && typeof a.heading !== 'string') ||
      (a.question !== undefined && typeof a.question !== 'string') ||
      (a.filter !== undefined && typeof a.filter !== 'string')
    )
      throw new Error('非法参数');
  }
  async execute(
    call: ToolCall,
    s: AgentSnapshot,
    o: AgentOptions,
    session: any,
  ): Promise<{
    output: string;
    evidence?: import('../rag/retrieval.types').OriginalEvidence[];
    summaryGroups?: { summary: string; refs: Record<string, string> }[];
    summaryCoverage?: any;
    handoff?: boolean;
  }> {
    await this.retrieval.verify(s.scope, o.signal);
    const a: any = call.args;
    if (call.name === 'list_documents') {
      const matching = s.scope.documents.filter((d) => !a.filter || d.filename.includes(a.filter));
      const cursor = a.cursor || 0,
        limit = Math.max(1, Math.min(20, a.limit || 20)),
        documents: any[] = [];
      for (const d of matching.slice(cursor, cursor + limit)) {
        if (Buffer.byteLength(JSON.stringify([...documents, d]), 'utf8') > 1700) break;
        documents.push(d);
      }
      const next = cursor + documents.length;
      return {
        output: JSON.stringify({
          documents,
          total: matching.length,
          complete: next >= matching.length,
          nextCursor: next < matching.length ? next : undefined,
        }),
      };
    }
    let evidence: any[] = [];
    let more: any = {};
    if (call.name.includes('search')) {
      let narrowed = session;
      if (a.documentIds?.length) {
        const ids = new Set<number>(a.documentIds);
        const chunks = session.chunks.filter((c: any) => ids.has(c.documentId));
        const documents = session.documents.filter((d: any) => ids.has(d.id));
        const revisionIds = new Set<number>(
          s.scope.documents.filter((d) => ids.has(d.documentId)).map((d) => d.indexRevisionId),
        );
        narrowed = {
          ...session,
          chunks,
          documents,
          revisions: new Map([...session.revisions].filter(([id]: any) => revisionIds.has(id))),
          byChunk: new Map(chunks.map((c: any) => [c.id, c])),
          byDoc: new Map(documents.map((d: any) => [d.id, d])),
        };
      }
      const result = await this.retrieval.search(narrowed, a.query, {
        strategy: call.name === 'keyword_search' ? 'keyword' : 'hybrid-rerank',
        limit: Math.min(20, a.limit || 8),
        signal: o.signal,
      });
      evidence = result.evidence;
    } else {
      const result = await this.retrieval.read(
        session,
        {
          documentId: a.documentId,
          pageStart: a.pageStart,
          pageEnd: a.pageEnd,
          heading: a.heading,
          cursor: a.cursor || 0,
          limit: call.name === 'summarize_document' ? 100 : 1,
        },
        o.signal,
      );
      evidence = result.evidence;
      more = { complete: result.complete, nextCursor: result.nextCursor };
      if (call.name === 'summarize_document') {
        let next = result.nextCursor;
        while (next !== undefined) {
          const page = await this.retrieval.read(
            session,
            {
              documentId: a.documentId,
              pageStart: a.pageStart,
              pageEnd: a.pageEnd,
              heading: a.heading,
              cursor: next,
              limit: 100,
            },
            o.signal,
          );
          evidence.push(...page.evidence);
          next = page.nextCursor;
        }
        evidence = this.retrieval.citationEvidence(evidence);
        if (await this.canAnswerDirectly?.(s, call, evidence)) {
          return { evidence, output: JSON.stringify({ complete: true,
            evidenceCount: evidence.length, pages: [...new Set(evidence.map(e => e.location?.page))],
            answerFromOriginal: true }) };
        }
        const summarized = await this.summary.summarizeAgent(
          evidence,
          {
            userId: s.userId,
            knowledgeBaseId: s.knowledgeBaseId,
            question: a.question || s.question,
            revisions: s.scope.documents.map((d) => d.indexRevisionId),
          },
          { ...this.execution(s, o), apiKey: o.apiKey, guard: o.guard },
        );
        const groups: any[] = [];
        for (const group of summarized.groups) {
          if (Buffer.byteLength(JSON.stringify([...groups, group]), 'utf8') > 1700) break;
          groups.push(group);
        }
        return {
          evidence,
          summaryGroups: summarized.groups,
          summaryCoverage: {
            ...summarized.coverage,
            documentId: a.documentId,
            fullDocument:
              a.pageStart === undefined &&
              a.pageEnd === undefined &&
              a.heading === undefined &&
              a.cursor === undefined &&
              a.offset === undefined,
          },
          output: JSON.stringify({
            groups,
            coverage: {
              ...summarized.coverage,
              returnedSections: groups.length,
              complete: groups.length === summarized.groups.length && summarized.coverage.complete,
            },
          }),
        };
      }
      if (evidence[0] && (a.offset || 0) > 0) {
        const e = evidence[0];
        const offset = a.offset;
        if (offset >= e.text.length) throw new Error('非法偏移');
        evidence = [
          this.retrieval.original({
            ...e,
            text: e.text.slice(offset),
            location: e.location ? sliceSourceLocation(e.location, e.location.start + offset, e.location.end) : null,
          }),
        ];
      }
    }
    const visible: any[] = [],
      retained: any[] = [];
    let remaining = Math.min(1200, Math.max(16, this.limit('AGENT_TOOL_TOKENS', 2000) - 600));
    for (const e of evidence) {
      if (remaining <= 0) break;
      let text = '';
      for (const ch of e.text) {
        const n = Buffer.byteLength(ch, 'utf8');
        if (n > remaining) break;
        text += ch;
        remaining -= n;
      }
      const partial = text.length < e.text.length;
      const original =
        partial && call.name === 'read_document'
          ? this.retrieval.original({
              ...e,
              text,
              location: e.location ? sliceSourceLocation(e.location, e.location.start, e.location.start + text.length) : null,
            })
          : e;
      retained.push(original);
      visible.push({
        evidenceId: original.evidenceId,
        filename: e.filename,
        page: e.location?.page ?? null,
        text,
      });
      if (partial)
        more = {
          complete: false,
          nextCursor: a.cursor || 0,
          nextOffset: (a.offset || 0) + text.length,
        };
    }
    while (
      visible.length &&
      Buffer.byteLength(JSON.stringify({ evidence: visible, ...more }), 'utf8') >
        this.limit('AGENT_TOOL_TOKENS', 2000)
    ) {
      visible.pop();
      more.complete = false;
    }
    return { output: JSON.stringify({ evidence: visible, ...more }), evidence: retained };
  }
}
