import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/api-error';
import { ParsedDocument, paragraphBlocks } from './parsed-document';

@Injectable()
export class DocumentParser {
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
          const content = await page.getTextContent();
          let previous: any;
          let pageText = '';
          for (const item of content.items as any[]) {
            if (!('str' in item)) continue;
            if (
              previous &&
              Math.abs(previous.transform[5] - item.transform[5]) >
                Math.max(previous.height, item.height) * 1.6
            )
              pageText += '\n\n';
            pageText += item.str + (item.hasEOL ? '\n' : '');
            previous = item;
          }
          const offset = pages.reduce((sum, p) => sum + p.length + 1, 0);
          blocks.push(...paragraphBlocks(pageText, i, offset));
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
        throw new ApiError(400, 'PDF 中未提取到文字；扫描件需要 OCR，本项目不提供 OCR');
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
