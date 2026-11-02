/** 从 PDF 文本层或 UTF-8 Markdown 提取带位置的文本块。 */
import { Injectable, Optional } from '@nestjs/common';
import { ApiError } from '../../../common/api-error';
import { ParsedDocument, paragraphBlocks } from './parsed-document';
import { PdfVisualService, ParseContext } from './pdf-visual.service';

@Injectable()
export class DocumentParser {
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
        for (let i = 1; i <= document.numPages; i++) {
          const page = await document.getPage(i);
          // 保留原生文字，再逐页补充图片、扫描文字和图解。
          const content = await page.getTextContent();
          let previous: any;
          let pageText = '';
          for (const item of content.items as any[]) {
            if (!('str' in item)) continue;
            // 根据文字纵向位置推断段落边界，减少 PDF 提取后所有内容粘成一段的问题。
            if (
              previous &&
              Math.abs(previous.transform[5] - item.transform[5]) >
                Math.max(previous.height, item.height) * 1.6
            )
              pageText += '\n\n';
            pageText += item.str + (item.hasEOL ? '\n' : '');
            previous = item;
          }
          // 记录页码和全局文本偏移，后续切块与引用都能追溯到原文位置。
          const offset = pages.reduce((sum, p) => sum + p.length + 1, 0);
          blocks.push(
            ...paragraphBlocks(pageText, i, offset).map((b) => ({
              ...b,
              location: { ...b.location, contentType: 'native' as const },
            })),
          );
          if (context && this.visual?.enabled) {
            try {
              const result = await this.visual.page(document, page, pageText, context);
              for (const supplement of result.blocks) {
                const labels = { ocr: '图片文字识别', table: '表格识别', figure: '模型生成的图解' };
                const value = `[${labels[supplement.type]}]\n${supplement.text}`;
                const separator = pageText ? '\n\n' : '';
                const start = offset + pageText.length + separator.length;
                blocks.push({
                  text: value,
                  location: {
                    page: i,
                    paragraph: null,
                    heading: null,
                    start,
                    end: start + value.length,
                    contentType: supplement.type,
                    pageImage: result.image,
                  },
                });
                pageText += separator + value;
              }
            } catch (error) {
              // 保留取消/取代任务的错误类型，供索引执行器正确终止。
              if (error instanceof Error)
                error.message = `PDF 第${i}页视觉解析失败：${error.message}`;
              progressError = error;
              throw error;
            }
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
