import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next/headers — cookies() is server-only and not available in jsdom.
const cookiesMock = vi.fn();
vi.mock('next/headers', () => ({ cookies: () => cookiesMock() }));

// `getRequestConfig` from next-intl wraps the loader callback. Stub it to a
// pass-through so the test can drive the loader directly without spinning up
// the full next-intl runtime.
vi.mock('next-intl/server', () => ({
  getRequestConfig: (loader: unknown) => loader,
}));

interface LoaderResult {
  locale: 'en' | 'zh';
  messages: Record<string, unknown>;
}
type Loader = () => Promise<LoaderResult>;

const ORIGINAL_FETCH = globalThis.fetch;

async function freshLoader(): Promise<{
  loader: Loader;
  reset: () => void;
}> {
  // Re-import on every test so the module-level cache (`serverLocaleCache`)
  // starts empty. `_resetLocaleCacheForTests` would also work but
  // resetModules also lets us re-pick up env-var changes between cases.
  vi.resetModules();
  const mod = (await import('./request')) as {
    default: Loader;
    _resetLocaleCacheForTests: () => void;
  };
  return { loader: mod.default, reset: mod._resetLocaleCacheForTests };
}

function setCookie(value: string | undefined): void {
  cookiesMock.mockReturnValue({
    get: (k: string) => (k === 'wizard-locale' && value ? { value } : undefined),
  });
}

function stubFetch(impl: (url: string) => Promise<Response> | Response): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    return impl(url);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  cookiesMock.mockReset();
  setCookie(undefined);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.GOLDPAN_LANGUAGE;
});

describe('i18n/request loader', () => {
  it('returns wizard-locale cookie when present (highest priority)', async () => {
    setCookie('zh');
    // fetch must NOT be called when cookie is present — guards against
    // re-introducing a server round-trip during the wizard flow where the
    // server is in wizard mode and has no DB-backed language yet.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { loader } = await freshLoader();
    const result = await loader();
    expect(result.locale).toBe('zh');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls through to server fetch when cookie missing', async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ language: 'zh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { loader } = await freshLoader();
    const result = await loader();
    expect(result.locale).toBe('zh');
  });

  it('falls back to env when server fetch fails', async () => {
    process.env.GOLDPAN_LANGUAGE = 'zh';
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const { loader } = await freshLoader();
    const result = await loader();
    expect(result.locale).toBe('zh');
  });

  it('falls back to default locale (en) when both server fetch and env are unset', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const { loader } = await freshLoader();
    const result = await loader();
    expect(result.locale).toBe('en');
  });

  it('falls back to env when server returns an unrecognized language', async () => {
    process.env.GOLDPAN_LANGUAGE = 'zh';
    stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ language: 'fr' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { loader } = await freshLoader();
    const result = await loader();
    expect(result.locale).toBe('zh');
  });

  it('caches successful server fetch within a process — second call does not re-fetch', async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify({ language: 'zh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    const { loader } = await freshLoader();
    await loader();
    await loader();
    expect(calls).toBe(1);
  });

  it('does NOT cache server-fetch failure — next call retries', async () => {
    // Wizard restart races leave a brief window where server is unreachable;
    // caching that null would pin the web process to the env fallback until
    // manual restart, defeating the purpose of going through the server.
    let calls = 0;
    stubFetch(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(
        new Response(JSON.stringify({ language: 'zh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    const { loader } = await freshLoader();
    const first = await loader();
    expect(first.locale).toBe('en'); // env not set, default fallback
    const second = await loader();
    expect(second.locale).toBe('zh');
    expect(calls).toBe(2);
  });

  it('treats non-2xx server response as failure (falls through to env)', async () => {
    process.env.GOLDPAN_LANGUAGE = 'zh';
    stubFetch(() => Promise.resolve(new Response('boom', { status: 500 })));
    const { loader } = await freshLoader();
    const result = await loader();
    expect(result.locale).toBe('zh');
  });
});
