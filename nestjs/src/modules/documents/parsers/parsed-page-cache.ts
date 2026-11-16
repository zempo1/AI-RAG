import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ParsedDocument, PageImageRef, RegionImageRef } from "./parsed-document";
import { isTransientRequestError } from "../../../common/transient-request";

export interface CachedPage {
  document: ParsedDocument;
  regions: number;
  analysisManifest?: string;
}
type Asset = PageImageRef | RegionImageRef;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Raw page-local results, BEFORE cross-page links; disk is the bounded reorder buffer. */
export class ParsedPageCache {
  constructor(
    private readonly directory: string,
    private readonly assetPath: (ref: Asset) => Promise<string | undefined>,
    private readonly validateManifest: (manifest: string) => Promise<boolean> = async () => true,
  ) {}
  private refs(page: CachedPage) {
    return page.document.blocks.flatMap(
      (b) => [b.location.pageImage, b.location.regionImage].filter(Boolean) as Asset[],
    );
  }
  async read(page: number): Promise<CachedPage | undefined> {
    try {
      const raw = JSON.parse(await readFile(join(this.directory, `${page}.json`), "utf8"));
      if (
        raw.schema !== 1 ||
        hash(JSON.stringify(raw.page)) !== raw.digest ||
        typeof raw.page?.document?.text !== "string" ||
        !Array.isArray(raw.page.document.blocks) ||
        !Number.isSafeInteger(raw.page.regions) ||
        raw.page.regions < 0
      )
        return;
      const result = raw.page as CachedPage;
      if (result.analysisManifest && !(await this.validateManifest(result.analysisManifest)))
        return;
      if (
        !result.document.blocks.every(
          (b) =>
            b.location?.page === page &&
            result.document.text.slice(b.location.start, b.location.end) === b.text,
        )
      )
        return;
      for (const ref of this.refs(result)) {
        const path = await this.assetPath(ref);
        if (!path || hash(await readFile(path)) !== raw.assets[JSON.stringify(ref)]) return;
      }
      return result;
    } catch (error: any) {
      if (error.code && error.code !== "ENOENT") throw error;
      return;
    }
  }
  async write(page: number, value: CachedPage) {
    const assets: Record<string, string> = {};
    for (const ref of this.refs(value)) {
      const path = await this.assetPath(ref);
      if (!path) throw new Error("页面缓存缺少引用图片");
      assets[JSON.stringify(ref)] = hash(await readFile(path));
    }
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${page}.json`),
      temp = path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(
        temp,
        JSON.stringify({ schema: 1, page: value, digest: hash(JSON.stringify(value)), assets }),
      );
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
}

export function retryablePageError(error: unknown) {
  return (
    isTransientRequestError(error) ||
    (error instanceof Error &&
      (/超时|Request was aborted|fetch failed|request timed out|connection error|HTTP (429|502|503|504)|模型未就绪/i.test(
        error.message,
      ) ||
        Number((error as any).status) === 429))
  );
}

/** Completion-driven workers continue past failed pages; retry failed pages after the first pass. */
export async function* spoolPages(
  count: number,
  concurrency: number,
  cache: ParsedPageCache,
  produce: (page: number) => Promise<CachedPage>,
  signal?: AbortSignal,
  completed?: (page: CachedPage, hit: boolean) => Promise<void>,
): AsyncGenerator<CachedPage> {
  const control = new AbortController();
  const canceled = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
  const gates = Array.from({ length: count }, () => {
    let resolve!: () => void;
    return {
      done: new Promise<void>((r) => {
        resolve = r;
      }),
      resolve,
    };
  });
  const failures = new Map<number, unknown>();
  let next = 1;
  const execute = async (n: number) => {
    canceled.throwIfAborted();
    const hit = await cache.read(n);
    const page = hit || (await produce(n));
    canceled.throwIfAborted();
    if (!hit) await cache.write(n, page);
    await completed?.(page, !!hit);
    failures.delete(n);
    gates[n - 1].resolve();
  };
  const worker = async () => {
    while (next <= count && !canceled.aborted) {
      const n = next++;
      try {
        await execute(n);
      } catch (error) {
        failures.set(n, error);
        if (!retryablePageError(error)) control.abort(error);
      }
    }
  };
  const running = (async () => {
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
      for (const [n, error] of [...failures]) {
        if (canceled.aborted) break;
        if (retryablePageError(error)) {
          try {
            await execute(n);
          } catch (retryError) {
            failures.set(n, retryError);
          }
        }
      }
    } finally {
      for (const gate of gates) gate.resolve();
    }
  })();
  try {
    for (let n = 1; n <= count; n++) {
      await gates[n - 1].done;
      canceled.throwIfAborted();
      if (failures.has(n)) throw failures.get(n);
      const page = await cache.read(n);
      if (!page) throw new Error(`PDF 第${n}页解析缓存校验失败`);
      yield page;
    }
  } finally {
    control.abort(new Error("页面消费已结束"));
    await running;
  }
}
