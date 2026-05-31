import { type Mock, vi } from 'vitest';

export interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type FetchHandler = (
  url: string,
  init?: RequestInit,
) => MockResponse | Promise<MockResponse>;

export function createMockFetch(handler: FetchHandler): Mock {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    const url = typeof input === 'string' ? input : input.toString();

    // Support asynchronous handlers (for race / cancellation tests) and
    // mid-flight abort via the caller's AbortSignal.
    const resultPromise = Promise.resolve(handler(url, init));
    let abortListener: (() => void) | undefined;
    const result = await new Promise<MockResponse>((resolve, reject) => {
      if (init?.signal) {
        abortListener = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        init.signal.addEventListener('abort', abortListener, { once: true });
      }
      resultPromise.then(resolve, reject);
    }).finally(() => {
      if (init?.signal && abortListener) {
        init.signal.removeEventListener('abort', abortListener);
      }
    });

    const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) {
        responseHeaders.set(k, v);
      }
    }
    return new Response(result.body !== undefined ? JSON.stringify(result.body) : null, {
      status: result.status,
      headers: responseHeaders,
    });
  }) as unknown as Mock;
}

export function installMockFetch(handler: FetchHandler): {
  mockFetch: Mock;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const mockFetch = createMockFetch(handler);
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  return {
    mockFetch,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
