/** 将解析内容切为检索片段并保留上下文元数据。 */
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
    textOffset = 0,
  ) {
    // 先合并同页、同标题下的顺序段落，保留章节边界，避免跨页混合上下文。
    const groups: ParsedBlock[] = [];
    for (const block of document.blocks) {
      const previous = groups.at(-1);
      if (
        previous &&
        previous.location.page === block.location.page &&
        previous.location.heading === block.location.heading &&
        previous.location.contentType === block.location.contentType &&
        previous.location.pageImage?.profile === block.location.pageImage?.profile &&
        previous.location.regionImage?.regionId === block.location.regionImage?.regionId &&
        previous.contextText === block.contextText &&
        block.location.start >= previous.location.end
      ) {
        previous.location.end = block.location.end;
        previous.text = document.text.slice(previous.location.start, block.location.end);
      } else groups.push({ ...block, location: { ...block.location } });
    }
    const output: (ParsedBlock & { retrievalMetadata: Record<string, unknown> })[] = [];
    for (const group of groups) {
      const context = group.contextText
        ? (await tokenizer.windows(group.contextText, 96, 0, profile.tokenizer))[0]?.text || ''
        : '';
      const contextRanges = this.contextRanges(document, group, textOffset);
      // 父块保留较完整上下文；子块负责精确检索，命中后可展开父块补足语义。
      for (const parent of await tokenizer.windows(group.text, 1536, 0, profile.tokenizer)) {
        const parentStart = group.location.start + parent.start;
        const parentLocation = {
          ...group.location,
          start: textOffset + parentStart,
          end: textOffset + group.location.start + parent.end,
        };
        const parentId = `${parentLocation.page ?? 'legacy'}:${parentLocation.start}:${parentLocation.end}`;
        // 子块保留 token 重叠，减少句子在切块边缘被截断而导致漏检。
        for (const child of await tokenizer.windows(parent.text, 384, 64, profile.tokenizer)) {
          if (!child.text.trim()) continue;
          const start = parentStart + child.start,
            end = parentStart + child.end;
          const initialBlock = [...document.blocks]
            .reverse()
            .find((b) => b.location.start <= start && b.location.page === group.location.page);
          // 将词频随片段保存，构建关键词索引时可直接复用，减少重复分词。
          const terms: Record<string, number> = {};
          const embeddingText = context ? `${child.text}\n\n相关正文：\n${context}` : child.text;
          const normalized = embeddingText.normalize('NFKC').toLowerCase();
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
              start: start + textOffset,
              end: end + textOffset,
            },
            retrievalMetadata: {
              parentId,
              parentText: parent.text,
              parentLocation,
              embeddingText,
              contextRanges,
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
  private contextRanges(document: ParsedDocument, block: ParsedBlock, textOffset: number) {
    return document.blocks
      .filter(
        (b) =>
          b.location.contentType === 'native' &&
          b.location.page === block.location.page &&
          block.location.relatedParagraphs?.includes(b.location.paragraph!),
      )
      .map((b) => ({ start: b.location.start + textOffset, end: b.location.end + textOffset }));
  }
  splitStructured(document: ParsedDocument, size = 500, overlap = 50, textOffset = 0) {
    const result: (ParsedBlock & { retrievalMetadata?: Record<string, unknown> })[] = [];
    for (const block of document.blocks) {
      let cursor = 0;
      for (const text of this.split(block.text, size, overlap)) {
        const index = block.text.indexOf(text, cursor);
        const start = textOffset + block.location.start + index;
        result.push({
          text,
          location: { ...block.location, start, end: start + text.length },
          ...(block.contextText
            ? {
                retrievalMetadata: {
                  embeddingText: text + '\n\n相关正文：\n' + block.contextText.slice(0, 300),
                  contextRanges: this.contextRanges(document, block, textOffset),
                },
              }
            : {}),
        });
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
