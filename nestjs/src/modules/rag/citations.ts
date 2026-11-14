/** 定义引用结构并清除答案中无效的引用编号。 */
import { SourceLocation, PdfTableLocation } from '../documents/parsers/parsed-document';

export interface Citation {
  number: number;
  documentId: number;
  knowledgeBaseId: number;
  versionId: number;
  indexRevisionId: number;
  chunkId: number;
  /** All original child chunks represented by an expanded parent or merged range. */
  chunkIds?: number[];
  filename: string;
  text: string;
  location: SourceLocation | null;
  /** Display title and exact original slices for a paragraph assembled in PDF reading order. */
  sectionTitle?: string;
  sourceSegments?: { text: string; location: SourceLocation; chunkIds: number[] }[];
  /** Request-local geometry for legacy chunks; removed when forming citation slices. */
  tableRegions?: { page: number; table: PdfTableLocation }[];
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
