export interface SourceLocation {
  page: number | null;
  paragraph: number | null;
  heading: string | null;
  start: number;
  end: number;
}
export interface ParsedBlock {
  text: string;
  location: SourceLocation;
}
export interface ParsedDocument {
  text: string;
  blocks: ParsedBlock[];
}

export function paragraphBlocks(text: string, page: number | null, offset = 0): ParsedBlock[] {
  let heading: string | null = null;
  let paragraph = 0;
  return [...text.matchAll(/\S[\s\S]*?(?=\n[ \t]*\n|$)/g)]
    .filter((m) => m[0].trim())
    .map((match) => {
      const value = match[0].trimEnd();
      const title = value.match(/^#{1,6}\s+(.+)(?:\n|$)/);
      if (title) heading = title[1].trim();
      return {
        text: value,
        location: {
          page,
          paragraph: ++paragraph,
          heading,
          start: offset + match.index!,
          end: offset + match.index! + value.length,
        },
      };
    });
}
