import { jest } from '@jest/globals';
import { retryTransientRequest } from '../src/common/transient-request';

it('retries a transient fetch failure once', async () => {
  const request = jest.fn<() => Promise<number>>()
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValueOnce(1);
  await expect(retryTransientRequest(request)).resolves.toBe(1);
  expect(request).toHaveBeenCalledTimes(2);
});

it('leaves rate limits to the shared cooldown', async () => {
  const error = Object.assign(new Error('rate limit'), { status: 429 });
  const request = jest.fn(async () => { throw error; });
  await expect(retryTransientRequest(request)).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
});

it('cancels the retry wait with the original reason', async () => {
  const controller = new AbortController();
  const reason = new Error('document deleted');
  const request = jest.fn(async () => { throw new Error('Request timed out.'); });
  const result = retryTransientRequest(request, controller.signal);
  await Promise.resolve();
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  expect(request).toHaveBeenCalledTimes(1);
});
