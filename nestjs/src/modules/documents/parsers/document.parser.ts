/** 从 PDF 文本层或 UTF-8 Markdown 提取带位置的文本块。 */
import { Injectable, Optional, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiError } from '../../../common/api-error';
import { ParsedDocument, paragraphBlocks } from './parsed-document';
import { PdfVisualService, ParseContext, markPdfFailure } from './pdf-visual.service';
import { localRendering } from './vision-scheduler';
import { textPositions } from './pdf-layout';

type PageProgress = (done: number, total: number) => void | Promise<void>;

@Injectable()
export class DocumentParser {
  private readonly logger = new Logger(DocumentParser.name);
  constructor(@Optional() private readonly visual?: PdfVisualService) {}
  validateFilename(filename: string): void {
    if (
      !filename ||
      filename.length > 255 ||
      /[\\/\x00-\x1f]/.test(filename) ||
      !/\.(pdf|md)$/i.test(filename)
    )
      throw new ApiError(400, '文件必须是 PDF 或 Markdown 格式！');
  }

  async parse(bytes: Buffer, filename: string): Promise<string> {
    return (await this.parseStructured(bytes, filename)).text;
  }

  async parseStructured(
    bytes: Buffer,
    filename: string,
    progress?: PageProgress,
    context?: ParseContext,
  ): Promise<ParsedDocument> {
    this.validateFilename(filename);
    if (!bytes.length) throw new ApiError(400, '文件不能为空');
    if (!/\.pdf$/i.test(filename)) {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
      } catch {
        throw new ApiError(400, 'Markdown 必须使用 UTF-8 编码');
      }
      if (!text.trim()) throw new ApiError(400, '文档内容不能为空');
      await progress?.(1, 1);
      return { text, blocks: paragraphBlocks(text, null) };
    }
    const pages: string[] = [];
    const blocks: ParsedDocument['blocks'] = [];
    let offset = 0;
    for await (const page of this.parsePages(bytes, context, progress)) {
      pages.push(page.text);
      for (const block of page.blocks)
        blocks.push({
          ...block,
          location: {
            ...block.location,
            start: block.location.start + offset,
            end: block.location.end + offset,
          },
        });
      offset += page.text.length + 1;
    }
    return { text: pages.join('\n'), blocks };
  }

  /** A bounded stream of page-local text and offsets, in PDF page order. */
  async *parsePages(
    bytes: Uint8Array,
    original?: ParseContext,
    progress?: PageProgress,
  ): AsyncGenerator<ParsedDocument> {
    if (!bytes.length) throw new ApiError(400, '文件不能为空');
    if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-')))
      throw new ApiError(400, 'PDF 文件格式无效');
    await original?.guard?.();
    original?.signal?.throwIfAborted();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      verbosity: 0,
    });
    let document: Awaited<typeof task.promise>;
    try {
      document = await task.promise;
    } catch (error) {
      await task.destroy();
      original?.signal?.throwIfAborted();
      throw Object.assign(new ApiError(400, 'PDF 解析失败：文件损坏、加密或格式不受支持'), {
        cause: error,
      });
    }

    const controller = new AbortController();
    const signal = original?.signal
      ? AbortSignal.any([controller.signal, original.signal])
      : controller.signal;
    const check = async () => {
      signal.throwIfAborted();
      try {
        await original?.guard?.();
      } catch (error) {
        controller.abort(error);
        throw error;
      }
      signal.throwIfAborted();
    };
    const enhanced = Boolean(original && this.visual?.enabled);
    const counts = { textPages: 0, regions: 0, scanPages: 0, fallbackPages: 0 };
    const window = enhanced ? Math.max(1, Math.min(3, this.visual!.concurrency || 1)) : 1;
    const pending = new Map<number, Promise<ParsedDocument | undefined>>();
    let firstFailure: unknown;
    let closed = false;
    let hasContent = false;
    let finished = 0;
    let prepared = 0;
    let regionTotal = 0;
    let regionDone = 0;
    let lastReport = -Infinity;
    let stage: 'ocr' | 'vision' | undefined;
    let initialRecognition: { done: number; total: number | null } | undefined;
    let reporting = Promise.resolve();
    let polling: Promise<void> | undefined;
    const report = (force = false) => {
      if (!force && Date.now() - lastReport < 500) return reporting;
      lastReport = Date.now();
      const pageCount = finished;
      const done = regionDone;
      const total = prepared === document.numPages ? regionTotal : null;
      const currentStage = stage;
      if (!currentStage && enhanced) initialRecognition ??= { done, total };
      const initial = currentStage ? initialRecognition : undefined;
      if (initial) initialRecognition = undefined;
      reporting = reporting.then(async () => {
        await original?.progress?.({
          pages: pageCount,
          totalPages: document.numPages,
          regions: done,
          totalRegions: enhanced ? total : 0,
        });
        if (currentStage && original?.stage) {
          if (initial && (initial.done !== done || initial.total !== total))
            await original.stage(currentStage, initial.done, initial.total);
          await original.stage(currentStage, done, total);
        }
      });
      return reporting;
    };
    const beforeRequest = () => {
      signal.throwIfAborted();
      if (firstFailure) throw firstFailure;
      if (closed) throw new Error('PDF 页面流已关闭');
      original?.beforeRequest?.();
    };
    const context: ParseContext | undefined = enhanced
      ? {
          ...original!,
          sourceHash: createHash('sha256').update(bytes).digest('hex'),
          signal,
          guard: check,
          stage: async (nextStage) => {
            if (nextStage === 'vision' || (nextStage === 'ocr' && !stage)) {
              const changed = stage !== nextStage;
              stage = nextStage;
              if (changed) await report(true);
            }
          },
          beforeRequest,
          failed: (error) => {
            firstFailure ||= error;
            original?.failed?.(error);
          },
          discovered: (count) => {
            regionTotal += count;
            prepared++;
            return report();
          },
          completed: async () => {
            regionDone++;
            await report();
          },
        }
      : undefined;
    const poll = original?.guard
      ? setInterval(() => {
          polling ??= check()
            .catch(() => {})
            .finally(() => {
              polling = undefined;
            });
        }, 1000)
      : undefined;
    const processPage = async (i: number): Promise<ParsedDocument> => {
      const blocks: ParsedDocument['blocks'] = [];
      beforeRequest();
      await check();
      const page = await document.getPage(i);
      try {
        // 保留原生文字，再逐页补充图片、扫描文字和图解。
        const content = await localRendering.run(() => page.getTextContent(), signal);
        let previous: any;
        let pageText = '';
        const itemRanges: { start: number; end: number }[] = [];
        for (const item of content.items as any[]) {
          if (!('str' in item)) continue;
          // PDF.js 可能用一个宽空白 item 表示栏间距。
          if (!item.str.trim() && item.width > Math.max(previous?.height || 10, item.height) * 2)
            pageText += '\n\n';
          // 根据文字纵向位置推断段落边界，减少 PDF 提取后所有内容粘成一段的问题。
          if (
            previous &&
            (Math.abs(previous.transform[5] - item.transform[5]) >
              Math.max(previous.height, item.height) * 1.6 ||
              (Math.abs(previous.transform[5] - item.transform[5]) <
                Math.max(previous.height, item.height) &&
                item.transform[4] - previous.transform[4] - previous.width >
                  Math.max(previous.height, item.height) * 2))
          )
            pageText += '\n\n';
          const itemStart = pageText.length;
          pageText += item.str + (item.hasEOL ? '\n' : '');
          itemRanges.push({ start: itemStart, end: pageText.length });
          previous = item;
        }
        // 每页独立保留局部偏移；收集整份文档时统一平移为全局偏移。
        const nativeBlocks = paragraphBlocks(pageText, i).map((b) => ({
          ...b,
          location: { ...b.location, contentType: 'native' as const },
        }));
        const entries: { order: number; block: ParsedDocument['blocks'][number] }[] =
          nativeBlocks.map((block, n) => ({ order: n, block }));
        if (context && this.visual) {
          try {
            const result = await this.visual.page(document, page, pageText, context, content);
            if (result.stats)
              for (const key of Object.keys(counts) as (keyof typeof counts)[])
                counts[key] += result.stats[key];
            const positions = result.blocks.some((block) => block.regionImage?.kind === 'region')
              ? textPositions(content, page.getViewport({ scale: 1 }))
              : [];
            const paragraphItems = result.blocks.length
              ? nativeBlocks.map((b) =>
                  itemRanges
                    .map((r, index) =>
                      r.end > b.location.start && r.start < b.location.end ? index : -1,
                    )
                    .filter((n) => n >= 0),
                )
              : [];
            for (const supplement of result.blocks) {
              const labels = { ocr: '图片文字识别', table: '表格识别', figure: '模型生成的图解' };
              const value = `[${labels[supplement.type]}]\n${supplement.text}`;
              const ref = supplement.regionImage;
              const related = paragraphItems
                .map((items, index) =>
                  items.some((n) => supplement.textIndexes?.includes(n)) ? index + 1 : -1,
                )
                .filter((n) => n > 0);
              let anchor = nativeBlocks.length - 1;
              if (ref?.kind === 'region') {
                const [x0, y0, x1] = ref.bbox;
                anchor = -1;
                for (let n = 0; n < nativeBlocks.length; n++) {
                  if (
                    paragraphItems[n].some((index) => {
                      const b = positions[index]?.bbox;
                      return b && b[1] <= y0 && Math.min(b[2], x1) > Math.max(b[0], x0);
                    })
                  )
                    anchor = n;
                }
              }
              entries.push({
                order: anchor + 0.5,
                block: {
                  text: value,
                  contextText: supplement.contextText,
                  location: {
                    page: i,
                    paragraph: null,
                    heading: null,
                    start: 0,
                    end: 0,
                    contentType: supplement.type,
                    pageImage: result.image,
                    regionImage: ref,
                    relatedParagraphs: related,
                  },
                },
              });
            }
          } catch (error) {
            // 保留取消/取代任务的错误类型，供索引执行器正确终止。
            markPdfFailure(error, i);
            throw error;
          }
        }
        pageText = '';
        for (const { block } of entries.sort((a, b) => a.order - b.order)) {
          if (pageText) pageText += '\n\n';
          const start = pageText.length;
          blocks.push({
            ...block,
            location: { ...block.location, start, end: start + block.text.length },
          });
          pageText += block.text;
        }
        return { text: pageText, blocks };
      } finally {
        page.cleanup();
      }
    };
    let next = 1;
    try {
      for (let i = 1; i <= document.numPages; i++) {
        beforeRequest();
        while (pending.size < window && next <= document.numPages) {
          const number = next++;
          const page = processPage(number)
            .then(async (result) => {
              const completed = ++finished;
              await report(!enhanced);
              if (progress && (!enhanced || !original?.stage)) {
                reporting = reporting.then(async () => {
                  await progress(completed, document.numPages);
                });
                await reporting;
              }
              return result;
            })
            .catch((error) => {
              firstFailure ||= error;
              return undefined;
            });
          pending.set(number, page);
        }
        const result = await pending.get(i);
        pending.delete(i);
        beforeRequest();
        if (!result) throw new Error('PDF 页面未解析完成');
        hasContent ||= Boolean(result.text.trim());
        yield result;
      }
      if (enhanced) {
        if (regionTotal > 0) stage ??= 'vision';
        await report(true);
        this.logger.log(
          JSON.stringify({ event: 'pdf-document-layout', pages: document.numPages, ...counts }),
        );
      }
      beforeRequest();
      if (!hasContent)
        throw new ApiError(
          400,
          'PDF 中未提取到有效内容；扫描件请配置并启用视觉解析（OCR/图表）后重建索引',
        );
    } finally {
      closed = true;
      await Promise.all(pending.values());
      clearInterval(poll);
      await polling;
      await reporting.catch(() => {});
      await task.destroy();
    }
  }
}
