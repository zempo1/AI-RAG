export interface PageImageRef {
  versionId: number;
  page: number;
  profile: string;
}
/** 归一化坐标，原点为旋转后的页面左上角。 */
export type RegionBox = [number, number, number, number];
export interface RegionImageRef extends PageImageRef {
  regionId: string;
  bbox: RegionBox;
  kind: 'region' | 'scan' | 'fallback';
}
export type ContentType = 'native' | 'ocr' | 'table' | 'figure';
/** UTF-16 half-open range in final parsed text; normalized intrinsic page viewport. */
export interface PdfSourceAnchor {
  page: number;
  start: number;
  end: number;
  rects: RegionBox[];
  kind: 'native' | 'ocr' | 'region';
}
/** A local vector grid. Coordinates follow the same rotated viewport as source anchors. */
export interface PdfTableLocation {
  id: string;
  groupId: string;
  bbox: RegionBox;
  columns: number[];
  rows: number[];
  title?: string;
  continuedFrom?: number;
  continuedTo?: number;
}
export interface SourceLocation {
  anchorVersion?: 1;
  anchors?: PdfSourceAnchor[];
  contentType?: ContentType;
  pageImage?: PageImageRef;
  regionImage?: RegionImageRef;
  relatedParagraphs?: number[];
  table?: PdfTableLocation;
  page: number | null;
  paragraph: number | null;
  heading: string | null;
  headingPath?: string[];
  start: number;
  end: number;
}
export interface ParsedBlock {
  text: string;
  location: SourceLocation;
  /** 仅用于检索与父块展开，不计入原文偏移。 */
  contextText?: string;
}
export interface ParsedDocument {
  text: string;
  blocks: ParsedBlock[];
}

export function paragraphBlocks(text: string, page: number | null, offset = 0): ParsedBlock[] {
  let heading: string | null = null;
  const headingLevels: string[] = [];
  let paragraph = 0;
  return [...text.matchAll(/\S[\s\S]*?(?=\n[ \t]*\n|$)/g)]
    .filter((m) => m[0].trim())
    .map((match) => {
      const value = match[0].trimEnd();
      const title = value.match(/^(#{1,6})\s+(.+)(?:\n|$)/);
      if (title) {
        heading = title[2].trim();
        headingLevels.length = title[1].length - 1;
        headingLevels.push(heading);
      }
      return {
        text: value,
        location: {
          page,
          paragraph: ++paragraph,
          heading,
          headingPath: headingLevels.filter(Boolean),
          start: offset + match.index!,
          end: offset + match.index! + value.length,
        },
      };
    });
}
