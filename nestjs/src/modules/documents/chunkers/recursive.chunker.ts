import { Injectable } from '@nestjs/common';
import { ParsedBlock, ParsedDocument } from '../parsers/parsed-document';
import { TokenizerService } from '../../embeddings/tokenizer.service';
import { ModelProfile } from '../../embeddings/model-profile';

@Injectable()
export class RecursiveChunker {
  async splitTokenStructured(
    document: ParsedDocument,
    tokenizer: TokenizerService,
    profile: ModelProfile,
  ) {
    const groups: ParsedBlock[] = [];
    for (const block of document.blocks) {
      const previous = groups.at(-1);
      if (
        previous &&
        previous.location.page === block.location.page &&
        previous.location.heading === block.location.heading &&
        block.location.start >= previous.location.end
      ) {
        previous.location.end = block.location.end;
        previous.text = document.text.slice(previous.location.start, block.location.end);
      } else groups.push({ text: block.text, location: { ...block.location } });
    }
    const output: (ParsedBlock & { retrievalMetadata: Record<string, unknown> })[] = [];
    for (const group of groups) {
      for (const parent of await tokenizer.windows(group.text, 1536, 0, profile.tokenizer)) {
        const parentStart = group.location.start + parent.start;
        const parentLocation = {
          ...group.location,
          start: parentStart,
          end: group.location.start + parent.end,
        };
        const parentId = `${parentLocation.page ?? 'legacy'}:${parentLocation.start}:${parentLocation.end}`;
        for (const child of await tokenizer.windows(parent.text, 384, 64, profile.tokenizer)) {
          if (!child.text.trim()) continue;
          const start = parentStart + child.start,
            end = parentStart + child.end;
          const initialBlock = [...document.blocks]
            .reverse()
            .find((b) => b.location.start <= start && b.location.page === group.location.page);
          const terms: Record<string, number> = {};
          const normalized = child.text.normalize('NFKC').toLowerCase();
          const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(normalized)]
            .filter((w) => w.isWordLike && /\p{Script=Han}/u.test(w.segment))
            .map((w) => w.segment);
          words.push(...(normalized.match(/[a-z0-9][a-z0-9_.:/-]*/g) || []));
          for (const word of words) terms[word] = (terms[word] || 0) + 1;
          output.push({
            text: child.text,
            location: {
              ...group.location,
              paragraph: initialBlock?.location.paragraph ?? group.location.paragraph,
              start,
              end,
            },
            retrievalMetadata: {
              parentId,
              parentText: parent.text,
              parentLocation,
              sectionId: group.location.heading || `${group.location.page ?? 'legacy'}`,
              terms,
              tokenCount: child.tokenCount,
            },
          });
        }
      }
    }
    return output;
  }
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
