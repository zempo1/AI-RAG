/** 进程内共享配额；等待者只保留元数据，获得名额后才创建图片。 */
export class VisionScheduler {
  private active = 0;
  private waiters = new Set<() => void>();
  private until = 0;
  peak = 0;
  requests = 0;
  requestPeak = 0;
  rateLimits = 0;
  constructor(readonly limit: number) {}
  async ready(signal?: AbortSignal) {
    while (this.until > Date.now()) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          finish();
          reject(signal?.reason);
        };
        const timer = setTimeout(finish, Math.min(2147483647, this.until - Date.now()));
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    signal?.throwIfAborted();
  }
  cooldown(error: any) {
    if (Number(error?.status ?? error?.statusCode) !== 429) return;
    this.rateLimits++;
    const raw = error.headers?.get?.('retry-after') ?? error.headers?.['retry-after'];
    const seconds = raw == null ? NaN : Number(raw);
    const delay =
      Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw) - Date.now();
    this.until = Math.max(
      this.until,
      Date.now() + (Number.isFinite(delay) && delay >= 0 ? delay : 2000),
    );
  }
  async acquire(signal?: AbortSignal, canStart?: () => void): Promise<() => void> {
    for (;;) {
      canStart?.();
      signal?.throwIfAborted();
      if (this.active < this.limit && Date.now() >= this.until) {
        this.active++;
        this.peak = Math.max(this.peak, this.active);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active--;
          for (const wake of this.waiters) wake();
        };
      }
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal?.removeEventListener('abort', aborted);
          resolve();
        };
        const aborted = () => {
          done();
          reject(signal?.reason);
        };
        const timer = setTimeout(
          done,
          this.until > Date.now()
            ? Math.min(2147483647, Math.max(1, this.until - Date.now()))
            : 100,
        );
        this.waiters.add(done);
        signal?.addEventListener('abort', aborted, { once: true });
      });
    }
  }
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await work();
    } finally {
      release();
    }
  }
}
export const localRendering = new VisionScheduler(1);
const pools = new Map<number, VisionScheduler>();
export function visionPool(limit: number) {
  if (!pools.has(limit)) pools.set(limit, new VisionScheduler(limit));
  return pools.get(limit)!;
}
