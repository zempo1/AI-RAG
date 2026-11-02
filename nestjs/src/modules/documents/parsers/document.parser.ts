/** 从 PDF 文本层或 UTF-8 Markdown 提取带位置的文本块。 */
import { Injectable, Optional, Logger } from '@nestjs/common';
import { ApiError } from '../../../common/api-error';
import { ParsedDocument, paragraphBlocks } from './parsed-document';
import { PdfVisualService, ParseContext } from './pdf-visual.service';
import { textPositions } from './pdf-layout';

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
    progress?: (done: number, total: number) => void | Promise<void>,
    context?: ParseContext,
  ): Promise<ParsedDocument> {
    this.validateFilename(filename);
    if (!bytes.length) throw new ApiError(400, '文件不能为空');
    let text: string;
    const blocks: ParsedDocument['blocks'] = [];
    if (/\.pdf$/i.test(filename)) {
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
        throw new ApiError(400, 'PDF 文件格式无效');
      let task: any;
      let document: any;
      let progressError: unknown;
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        task = pdfjs.getDocument({
          data: new Uint8Array(bytes),
          useSystemFonts: true,
          verbosity: 0,
        });
        document = await task.promise;
        const pages: string[] = [];
        const counts = { textPages: 0, regions: 0, scanPages: 0, fallbackPages: 0 };
        for (let i = 1; i <= document.numPages; i++) {
          const page = await document.getPage(i);
          try {
            await context?.guard?.();
            await context?.stage?.('parsing', i, document.numPages);
          } catch (error) {
            progressError = error;
            throw error;
          }
          // 保留原生文字，再逐页补充图片、扫描文字和图解。
          const content = await page.getTextContent();
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
          // 记录页码和全局文本偏移，后续切块与引用都能追溯到原文位置。
          const offset = pages.reduce((sum, p) => sum + p.length + 1, 0);
          const nativeBlocks = paragraphBlocks(pageText, i).map((b) => ({
            ...b,
            location: { ...b.location, contentType: 'native' as const },
          }));
          const positions = textPositions(content, page.getViewport({ scale: 1 }));
          const paragraphItems = nativeBlocks.map((b) =>
            itemRanges
              .map((r, index) =>
                r.end > b.location.start && r.start < b.location.end ? index : -1,
              )
              .filter((n) => n >= 0),
          );
          const entries: { order: number; block: ParsedDocument['blocks'][number] }[] =
            nativeBlocks.map((block, n) => ({ order: n, block }));
          if (context && this.visual?.enabled) {
            try {
              const result = await this.visual.page(document, page, pageText, context, content);
              if (result.stats)
                for (const key of Object.keys(counts) as (keyof typeof counts)[])
                  counts[key] += result.stats[key];
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
              if (error instanceof Error)
                error.message = `PDF 第${i}页视觉解析失败：${error.message}`;
              progressError = error;
              throw error;
            }
          }
          pageText = '';
          for (const { block } of entries.sort((a, b) => a.order - b.order)) {
            if (pageText) pageText += '\n\n';
            const start = offset + pageText.length;
            blocks.push({
              ...block,
              location: { ...block.location, start, end: start + block.text.length },
            });
            pageText += block.text;
          }
          pages.push(pageText);
          page.cleanup();
          try {
            await progress?.(i, document.numPages);
          } catch (error) {
            progressError = error;
            throw error;
          }
        }
        text = pages.join('\n');
        if (context && this.visual?.enabled)
          this.logger.log(
            JSON.stringify({ event: 'pdf-document-layout', pages: document.numPages, ...counts }),
          );
      } catch (error) {
        if (progressError) throw progressError;
        throw Object.assign(new ApiError(400, 'PDF 解析失败：文件损坏、加密或格式不受支持'), {
          cause: error,
        });
      } finally {
        if (task) await task.destroy();
      }
      if (!text.trim())
        throw new ApiError(
          400,
          'PDF 中未提取到有效内容；扫描件请配置并启用视觉解析（OCR/图表）后重建索引',
        );
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
      } catch {
        throw new ApiError(400, 'Markdown 必须使用 UTF-8 编码');
      }
    }
    if (!text.trim()) throw new ApiError(400, '文档内容不能为空');
    if (!/\.pdf$/i.test(filename)) {
      blocks.push(...paragraphBlocks(text, null));
      await progress?.(1, 1);
    }
    return { text, blocks };
  }
}
