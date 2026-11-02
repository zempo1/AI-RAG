import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { Store } from '../../persistence/store';
import { ApiError } from '../../common/api-error';
import { PageImageRef, RegionImageRef } from './parsers/parsed-document';
import { Citation } from '../rag/citations';
import { VisionImage } from '../llm/llm.service';

export interface ParseScope {
  userId: number;
  documentId: number;
  versionId: number;
}

/** 页面资源不放入静态目录；所有外部读取都校验归属和删除状态。 */
@Injectable()
export class PageAssetsService {
  constructor(
    private readonly config: ConfigService,
    private readonly store: Store,
  ) {}

  private id(value: number) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ApiError(400, '页面资源标识无效');
    return String(value);
  }

  private documentDirectory(userId: number, documentId: number) {
    const root = resolve(this.config.getOrThrow<string>('PAGE_ASSETS_DIR'));
    const target = resolve(root, this.id(userId), this.id(documentId));
    const within = relative(root, target);
    if (!within || within.startsWith('..') || isAbsolute(within))
      throw new ApiError(400, '页面资源路径无效');
    return target;
  }

  directory(scope: ParseScope, profile: string) {
    if (!/^[a-f0-9]{64}$/.test(profile)) throw new ApiError(400, '页面解析配置标识无效');
    return join(
      this.documentDirectory(scope.userId, scope.documentId),
      this.id(scope.versionId),
      profile,
    );
  }

  async image(userId: number, documentId: number, ref: PageImageRef): Promise<Buffer> {
    return this.readImage(userId, documentId, ref, `${ref.page}.png`);
  }

  async regionImage(
    userId: number,
    documentId: number,
    ref: Pick<RegionImageRef, 'versionId' | 'page' | 'profile' | 'regionId'>,
  ): Promise<Buffer> {
    if (!/^[a-f0-9]{24}$/.test(ref.regionId)) throw new ApiError(400, '图片区域标识无效');
    return this.readImage(userId, documentId, ref, `${ref.page}-${ref.regionId}.png`);
  }

  private async readImage(
    userId: number,
    documentId: number,
    ref: PageImageRef,
    filename: string,
  ): Promise<Buffer> {
    this.id(ref.page);
    const path = this.directory({ userId, documentId, versionId: ref.versionId }, ref.profile);
    const doc = await this.store.get('documents', documentId);
    const version = await this.store.get('versions', ref.versionId);
    const library = doc && (await this.store.get('knowledgeBases', doc.knowledgeBaseId));
    if (
      !doc ||
      doc.userId !== userId ||
      doc.deletedAt ||
      !library ||
      library.userId !== userId ||
      library.deletedAt ||
      !version ||
      version.documentId !== doc.id
    )
      throw new ApiError(404, '页面来源不存在或不可访问');
    try {
      return await readFile(join(path, filename));
    } catch (error: any) {
      if (error.code === 'ENOENT') throw new ApiError(404, '页面图片不可用，请重新建立索引');
      throw error;
    }
  }

  async forSources(userId: number, sources: Citation[]): Promise<VisionImage[]> {
    const result: VisionImage[] = [],
      seen = new Set<string>();
    for (const source of sources) {
      const ref = source.location?.pageImage;
      if (!ref) continue;
      if (ref.versionId !== source.versionId || ref.page !== source.location?.page)
        throw new ApiError(409, '页面引用与证据版本不一致');
      const key = `${source.documentId}/${ref.versionId}/${ref.profile}/${ref.page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bytes = await this.image(userId, source.documentId, ref);
      result.push({
        label: `[${source.number}] 第${ref.page}页`,
        dataUrl: 'data:image/png;base64,' + bytes.toString('base64'),
      });
      if (result.length === 3) break;
    }
    return result;
  }

  async removeDocument(userId: number, documentId: number) {
    await rm(this.documentDirectory(userId, documentId), { recursive: true, force: true });
  }
}
