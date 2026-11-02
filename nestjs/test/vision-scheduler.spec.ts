import { VisionScheduler } from '../src/modules/documents/parsers/vision-scheduler';
it('honors cooldown and aborts queued requests without leaking capacity', async () => {
  const pool = new VisionScheduler(1),
    release = await pool.acquire();
  const controller = new AbortController();
  const waiting = pool.acquire(controller.signal);
  const error = new Error('cancel');
  controller.abort(error);
  await expect(waiting).rejects.toBe(error);
  release();
  pool.cooldown({ status: 429, headers: { 'retry-after': '.04' } });
  let entered = false;
  const next = pool.run(async () => {
    entered = true;
  });
  await new Promise((r) => setTimeout(r, 5));
  expect(entered).toBe(false);
  await next;
  expect(entered).toBe(true);
});
it('bounds shared concurrent requests and releases slots after errors', async () => {
  const pool = new VisionScheduler(3);
  let active = 0,
    peak = 0;
  await Promise.all(
    Array.from({ length: 9 }, (_, i) =>
      pool
        .run(async () => {
          active++;
          peak = Math.max(peak, active);
          try {
            await new Promise((r) => setTimeout(r, 20));
            if (i === 2) throw new Error('failure');
          } finally {
            active--;
          }
        })
        .catch(() => {}),
    ),
  );
  expect(peak).toBe(3);
  expect(active).toBe(0);
});
