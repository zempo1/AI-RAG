import type { ConfigService } from '@nestjs/config';
import { join, resolve } from 'node:path';
import type { RegionBox } from './parsed-document';
import type { ParseScope } from '../page-assets.service';
import { VisionScheduler } from './vision-scheduler';

// The local service owns one inference child. Keep its bounded queue from
// overflowing when several pages each discover multiple OCR regions.
const localInference = new VisionScheduler(1);

export type LayoutKind =
  'text' | 'title' | 'table' | 'figure' | 'caption' | 'decoration' | 'unknown';
export interface LayoutRegion {
  kind: LayoutKind;
  bbox: RegionBox;
  score: number;
}
export interface LayoutResult {
  regions: LayoutRegion[];
  manifest: string;
}
export interface OcrBlock {
  text: string;
  bbox: RegionBox;
  score: number;
}
export interface OcrResult {
  blocks: OcrBlock[];
  manifest: string;
}
export interface AnalysisHealth {
  ready: boolean;
  manifest: string;
}

const kinds: readonly string[] = [
  'text',
  'title',
  'table',
  'figure',
  'caption',
  'decoration',
  'unknown',
];
const invalid = (field: string): never => {
  throw new Error(`PDF 分析服务响应格式错误：${field}`);
};
function manifest(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) invalid('manifest');
  return value as string;
}
function geometry(row: any, field: string) {
  const box = row?.bbox;
  if (
    !Array.isArray(box) ||
    box.length !== 4 ||
    !box.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) ||
    box[0] >= box[2] ||
    box[1] >= box[3]
  )
    invalid(`${field}.bbox`);
  if (
    typeof row.score !== 'number' ||
    !Number.isFinite(row.score) ||
    row.score < 0 ||
    row.score > 1
  )
    invalid(`${field}.score`);
}
export function validateLayout(raw: any): LayoutResult {
  if (!Array.isArray(raw?.regions)) invalid('regions');
  for (const [i, row] of raw.regions.entries()) {
    if (!kinds.includes(row?.kind)) invalid(`regions[${i}].kind`);
    geometry(row, `regions[${i}]`);
  }
  return { regions: raw.regions, manifest: manifest(raw.manifest) };
}
export function validateOcr(raw: any): OcrResult {
  if (!Array.isArray(raw?.blocks)) invalid('blocks');
  for (const [i, row] of raw.blocks.entries()) {
    if (typeof row?.text !== 'string') invalid(`blocks[${i}].text`);
    geometry(row, `blocks[${i}]`);
  }
  return { blocks: raw.blocks, manifest: manifest(raw.manifest) };
}

/** Internal local service boundary. A service failure must remain visible to the indexing worker. */
export class PdfAnalysisClient {
  private lastManifest?: string;
  readonly timeoutMs: number;
  private readonly url: string;
  constructor(readonly config: Pick<ConfigService, 'get'>) {
    this.url = String(config.get('PDF_ANALYSIS_URL') || 'http://127.0.0.1:8091').replace(
      /\/+$/,
      '',
    );
    this.timeoutMs = Number(config.get('PDF_ANALYSIS_TIMEOUT_MS') ?? 95000);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
      throw new Error('PDF_ANALYSIS_TIMEOUT_MS 必须为正数');
  }
  get modelManifest() {
    return this.lastManifest;
  }
  cacheDirectory(scope: ParseScope): string | undefined {
    const root = this.config.get<string>('PAGE_ASSETS_DIR');
    if (!root) return undefined;
    const ids = [scope.userId, scope.documentId, scope.versionId];
    if (!ids.every((id) => Number.isSafeInteger(id) && id > 0))
      throw new Error('PDF 分析缓存作用域无效');
    return join(resolve(root), ...ids.map(String), 'layout');
  }
  private async request(path: string, body?: FormData, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const result = await fetch(this.url + path, {
        method: body ? 'POST' : 'GET',
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      signal?.throwIfAborted();
      if (!result.ok) {
        const detail = (await result.text()).slice(0, 500);
        throw new Error(`PDF 分析服务 ${path} 返回 HTTP ${result.status}：${detail}`);
      }
      let raw: unknown;
      try {
        raw = await result.json();
      } catch {
        invalid(`${path} JSON`);
      }
      signal?.throwIfAborted();
      return raw;
    } catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted)
        throw new Error(`PDF 分析服务 ${path} 超时（${this.timeoutMs}ms）`, { cause: error });
      if (error instanceof Error && error.message.startsWith('PDF 分析')) throw error;
      throw new Error(
        `PDF 分析服务 ${path} 请求失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  async health(signal?: AbortSignal): Promise<AnalysisHealth> {
    const result = await this.request('/health', undefined, signal);
    if (typeof result?.ready !== 'boolean') invalid('ready');
    const current = manifest(result.manifest);
    if (!result.ready) throw new Error('PDF 分析服务模型未就绪');
    this.lastManifest = current;
    return { ready: true, manifest: current };
  }
  private upload(bytes: Buffer) {
    const body = new FormData();
    body.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'page.png');
    return body;
  }
  async layout(
    bytes: Buffer,
    precision: 'standard' | 'high',
    signal?: AbortSignal,
  ): Promise<LayoutResult> {
    return localInference.run(async () => {
      const body = this.upload(bytes);
      body.append('precision', precision);
      const result = validateLayout(await this.request('/v1/layout', body, signal));
      this.lastManifest = result.manifest;
      return result;
    }, signal);
  }
  async ocr(bytes: Buffer, signal?: AbortSignal): Promise<OcrResult> {
    return localInference.run(async () => {
      const result = validateOcr(await this.request('/v1/ocr', this.upload(bytes), signal));
      this.lastManifest = result.manifest;
      return result;
    }, signal);
  }
}
