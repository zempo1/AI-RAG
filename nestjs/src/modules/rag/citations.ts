import { SourceLocation } from '../documents/parsers/parsed-document';

export interface Citation {
  number: number;
  documentId: number;
  knowledgeBaseId: number;
  versionId: number;
  indexRevisionId: number;
  chunkId: number;
  filename: string;
  text: string;
  location: SourceLocation | null;
  score: number;
  sourceDeleted?: boolean;
  sourceOutdated?: boolean;
}

export function normalizeCitations(answer: string, sources: Citation[]) {
  const available = new Map(sources.map((source) => [source.number, source]));
  const used = new Map<number, Citation>();
  const normalized = answer.replace(/\[(\d+)\]/g, (marker, number) => {
    const source = available.get(Number(number));
    if (!source) return '';
    used.set(source.number, source);
    return marker;
  });
  return {
    answer: normalized,
    citations: [...used.values()].map((source) => structuredClone(source)),
  };
}

export const NO_CONTEXT_ANSWER = '当前知识库中没有找到足够的相关资料，无法根据文档回答。';
