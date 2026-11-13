import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stat, readFile } from 'node:fs/promises';
import { basename, resolve, relative, isAbsolute } from 'node:path';
import { Store, Row } from '../../persistence/store';
import { ApiError } from '../../common/api-error';

export function byteRange(value: string | undefined, size: number) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  const invalid = () => {
    throw new ApiError(416, '请求的文件范围无效');
  };
  if (!match || (!match[1] && !match[2]) || size <= 0) return invalid();
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(requestedEnd)) return invalid();
    end = Math.min(requestedEnd, size - 1);
  }
  if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start) return invalid();
  return { start, end };
}

@Injectable()
export class DocumentOriginalsService {
  constructor(
    private readonly config: ConfigService,
    private readonly store: Store,
  ) {}

  private async version(userId: number, documentId: number, versionId?: number) {
    const doc = await this.store.get('documents', documentId);
    const library = doc && (await this.store.get('knowledgeBases', doc.knowledgeBaseId));
    if (
      !doc ||
      doc.userId !== userId ||
      doc.deletedAt ||
      !library ||
      library.userId !== userId ||
      library.deletedAt
    )
      throw new ApiError(404, '文档来源不存在或不可访问');
    const version =
      versionId !== undefined
        ? await this.store.get('versions', versionId)
        : doc.activeVersionId
          ? await this.store.get('versions', doc.activeVersionId)
          : (await this.store.list('versions', { documentId }, { orderBy: 'id', limit: 1 }))[0];
    if (!version || version.documentId !== documentId) throw new ApiError(404, '文档版本不存在');
    return version;
  }

  private async original(version: Row) {
    if (!version.originalPath) return null;
    const root = resolve(this.config.getOrThrow<string>('ORIGINALS_DIR'));
    const path = resolve(root, version.originalPath);
    const within = relative(root, path);
    if (
      basename(version.originalPath) !== version.originalPath ||
      !within ||
      within.startsWith('..') ||
      isAbsolute(within)
    )
      throw new ApiError(400, '原件路径无效');
    try {
      const info = await stat(path);
      return info.isFile() ? { path, size: info.size } : null;
    } catch (error: any) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async preview(userId: number, documentId: number, versionId?: number) {
    const version = await this.version(userId, documentId, versionId);
    const original = await this.original(version);
    const pdf = /\.pdf$/i.test(version.filename);
    const text =
      !pdf && !version.content && original
        ? await readFile(original.path, 'utf8')
        : version.content || '';
    return {
      documentId,
      versionId: version.id,
      filename: version.filename,
      mimeType: pdf ? 'application/pdf' : 'text/markdown',
      originalAvailable: !!original,
      originalUrl: original ? `/api/documents/${documentId}/versions/${version.id}/original` : null,
      ...(!pdf ? { text } : {}),
    };
  }

  async file(userId: number, documentId: number, versionId: number) {
    const version = await this.version(userId, documentId, versionId);
    if (!/\.pdf$/i.test(version.filename)) throw new ApiError(415, '此来源不是 PDF');
    const original = await this.original(version);
    if (!original) throw new ApiError(404, '原始文件不可用');
    return { ...original, filename: version.filename };
  }
}
