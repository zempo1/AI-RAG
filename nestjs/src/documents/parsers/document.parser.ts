import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/api-error';

// Keep native import when compiling CommonJS: PDF.js is an ESM package.
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  s: string,
) => Promise<any>;

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
    this.validateFilename(filename);
    if (!bytes.length) throw new ApiError(400, '文件不能为空');
    let text: string;
    if (/\.pdf$/i.test(filename)) {
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
        throw new ApiError(400, 'PDF 文件格式无效');
      let task: any;
      let document: any;
      try {
        const pdfjs = await nativeImport('pdfjs-dist/legacy/build/pdf.mjs');
        task = pdfjs.getDocument({
          data: new Uint8Array(bytes),
          useSystemFonts: true,
          isEvalSupported: false,
          verbosity: 0,
        });
        document = await task.promise;
        const pages: string[] = [];
        for (let i = 1; i <= document.numPages; i++) {
          const page = await document.getPage(i);
          const content = await page.getTextContent();
          pages.push(
            content.items
              .map((item: any) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
              .join(''),
          );
          page.cleanup();
        }
        text = pages.join('\n');
      } catch {
        throw new ApiError(400, 'PDF 解析失败：文件损坏、加密或格式不受支持');
      } finally {
        if (task) await task.destroy();
      }
      if (!text.trim())
        throw new ApiError(400, 'PDF 中未提取到文字；扫描件需要 OCR，本项目不提供 OCR');
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new ApiError(400, 'Markdown 必须使用 UTF-8 编码');
      }
    }
    if (!text.trim()) throw new ApiError(400, '文档内容不能为空');
    return text;
  }
}
