// apps/server/tests/routes/onboarding/test-provider.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { testProvider } from '../../../src/routes/onboarding/test-provider.js';

describe('testProvider', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('OpenAI uses GET /v1/models with Bearer auth', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    const r = await testProvider({ providerId: 'openai', apiKey: 'sk' });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/v1/models'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer sk' }),
      }),
    );
  });

  test('Anthropic uses GET /v1/models with x-api-key + anthropic-version', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    const r = await testProvider({ providerId: 'anthropic', apiKey: 'sk-ant' });
    expect(r.ok).toBe(true);
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toContain('/v1/models');
    expect(call[1].method).toBe('GET');
    expect(call[1].headers).toMatchObject({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
    });
  });

  test('Google uses GET /v1beta/models with key query param', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    const r = await testProvider({ providerId: 'google', apiKey: 'g-key' });
    expect(r.ok).toBe(true);
    const call = fetchSpy.mock.calls[0];
    const url = call[0] instanceof URL ? call[0].toString() : String(call[0]);
    expect(url).toContain('/v1beta/models');
    expect(url).toContain('key=g-key');
    expect(call[1].method).toBe('GET');
  });

  test('DeepSeek uses POST /chat/completions max_tokens=1', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const r = await testProvider({ providerId: 'deepseek', apiKey: 'sk' });
    expect(r.ok).toBe(true);
    const call = fetchSpy.mock.calls[0];
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body as string);
    expect(body.max_tokens).toBe(1);
  });

  test('Ollama uses GET /api/tags (no key, strips /v1 from base)', async () => {
    fetchSpy.mockResolvedValue({ ok: true });
    const r = await testProvider({
      providerId: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(r.ok).toBe(true);
    const call = fetchSpy.mock.calls[0];
    const url = call[0] instanceof URL ? call[0].toString() : String(call[0]);
    expect(url).toContain('/api/tags');
    expect(url).not.toContain('/v1/api/tags');
  });

  test('rejects non-loopback Ollama baseUrl before fetch', async () => {
    const r = await testProvider({
      providerId: 'ollama',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/loopback|localhost|private/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects private cloud-provider baseUrl before fetch', async () => {
    const r = await testProvider({
      providerId: 'openai',
      apiKey: 'sk',
      baseUrl: 'http://127.0.0.1:1234',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/private|reserved|loopback/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('returns ok=false with error on 401', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const r = await testProvider({ providerId: 'openai', apiKey: 'bad' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('401');
  });

  test('5s timeout aborts hung request', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(
      (_url, opts) =>
        new Promise((_, reject) => {
          const sig = (opts as RequestInit).signal as AbortSignal;
          sig.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const promise = testProvider({ providerId: 'openai', apiKey: 'sk' });
    await vi.advanceTimersByTimeAsync(5500);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout|aborted/i);
    vi.useRealTimers();
  });

  test('unknown provider returns ok=false', async () => {
    const r = await testProvider({ providerId: 'mystery', apiKey: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown|unsupported/i);
  });
});
