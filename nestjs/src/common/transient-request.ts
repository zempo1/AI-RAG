import { setTimeout } from 'node:timers/promises';

export function isTransientRequestError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const response = error as Error & { status?: number; statusCode?: number };
  return [502, 503, 504].includes(Number(response.status ?? response.statusCode)) ||
    /^(?:APIConnectionError|APIConnectionTimeoutError|TimeoutError)$/.test(error.name) ||
    /^(?:fetch failed|request timed out\.?|connection error\.?)$/i.test(error.message);
}

/** Retry a single request once, while keeping cancellation and admission checks active. */
export async function retryTransientRequest<T>(request: () => Promise<T>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    return await request();
  } catch (error) {
    signal?.throwIfAborted();
    if (!isTransientRequestError(error)) throw error;
    try {
      await setTimeout(350, undefined, { signal });
    } catch (waitError) {
      signal?.throwIfAborted();
      throw waitError;
    }
    return request();
  }
}
