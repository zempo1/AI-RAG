import { Injectable } from '@nestjs/common';
import { ParsedBlock, ParsedDocument } from '../parsers/parsed-document';

@Injectable()
export class RecursiveChunker {
  splitStructured(document: ParsedDocument, size = 500, overlap = 50): ParsedBlock[] {
    const result: ParsedBlock[] = [];
    for (const block of document.blocks) {
      let cursor = 0;
      for (const text of this.split(block.text, size, overlap)) {
        const index = block.text.indexOf(text, cursor);
        const start = block.location.start + index;
        result.push({ text, location: { ...block.location, start, end: start + text.length } });
        cursor = Math.max(index + text.length - overlap, index + 1);
      }
    }
    return result;
  }
  split(text: string, size = 500, overlap = 50): string[] {
    if (size <= overlap || overlap < 0) throw new Error('Invalid chunk size/overlap');
    const result: string[] = [];
    let start = 0;
    text = text.trim();
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      if (end < text.length) {
        const window = text.slice(start, end);
        // Prefer paragraph, line, sentence and word boundaries before character fallback.
        for (const separator of ['\n\n', '\n', '。', '. ', '！', '？', ' ']) {
          const index = window.lastIndexOf(separator);
          if (index >= size / 2) {
            end = start + index + separator.length;
            break;
          }
        }
      }
      const chunk = text.slice(start, end).trim();
      if (chunk) result.push(chunk);
      if (end === text.length) break;
      start = end - overlap;
    }
    return result;
  }
}
