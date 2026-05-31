import {
  emitCollectDiagnostic,
  parseCollectedHtml,
  validateSsrfIfEnabled,
} from '@goldpan/core/plugins';
import { chromium } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectorBrowserPlugin } from './index.js';

const { MockPlaywrightTimeoutError } = vi.hoisted(() => ({
  MockPlaywrightTimeoutError: class MockPlaywrightTimeoutError extends Error {},
}));

vi.mock('@goldpan/core/plugins', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@goldpan/core/plugins')>();
  return {
    ...actual,
    parseCollectedHtml: vi.fn(() => ({
      content: 'rendered markdown',
      title: 'Rendered Title',
      metadata: { collector_finalUrl: 'https://example.com/rendered' },
      finalUrl: 'https://example.com/rendered',
    })),
    validateSsrfIfEnabled: vi.fn(),
    emitCollectDiagnostic: vi.fn(),
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
  },
  errors: {
    TimeoutError: MockPlaywrightTimeoutError,
  },
}));

const noopLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('collectorBrowserPlugin', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('GOLDPAN_BROWSER_EXECUTABLE_PATH', '');
    await collectorBrowserPlugin.initialize?.({
      logger: noopLogger as any,
      pluginConfig: { collectTimeoutSeconds: 30 },
    });
  });

  afterEach(async () => {
    await collectorBrowserPlugin.destroy?.();
  });

  it('matches http and https urls', () => {
    expect(collectorBrowserPlugin.canHandle({ url: 'https://example.com' })).toBe(true);
    expect(collectorBrowserPlugin.canHandle({ url: 'http://example.com' })).toBe(true);
    expect(collectorBrowserPlugin.canHandle({ url: 'ftp://example.com' })).toBe(false);
  });

  it('collects rendered HTML with Playwright and parses it through the shared HTML helper', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue('<html><body><article>Rendered</article></body></html>'),
      url: vi.fn().mockReturnValue('https://example.com/rendered'),
      close: vi.fn().mockResolvedValue(undefined),
      route: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);

    const result = await collectorBrowserPlugin.collect(
      { url: 'https://example.com' },
      new AbortController().signal,
    );

    expect(validateSsrfIfEnabled).toHaveBeenCalledWith('https://example.com', true);
    expect(chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, channel: 'chrome' }),
    );
    expect(page.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    expect(parseCollectedHtml).toHaveBeenCalledWith(
      '<html><body><article>Rendered</article></body></html>',
      'https://example.com/rendered',
    );
    expect(result).toEqual({
      content: 'rendered markdown',
      title: 'Rendered Title',
      metadata: {
        collector_finalUrl: 'https://example.com/rendered',
        collector_browserEngine: 'system_chrome',
        collector_browserEngineLabel: 'System-installed Google Chrome (Playwright channel=chrome)',
      },
      finalUrl: 'https://example.com/rendered',
    });
  });

  it('passes executablePath to Playwright when GOLDPAN_BROWSER_EXECUTABLE_PATH is set', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue('<html><body><article>Rendered</article></body></html>'),
      url: vi.fn().mockReturnValue('https://example.com/rendered'),
      close: vi.fn().mockResolvedValue(undefined),
      route: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubEnv(
      'GOLDPAN_BROWSER_EXECUTABLE_PATH',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);

    await collectorBrowserPlugin.collect(
      { url: 'https://example.com' },
      new AbortController().signal,
    );

    expect(chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: true,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }),
    );
  });

  it('uses channel chrome when browserStrategy is system-chrome', async () => {
    await collectorBrowserPlugin.destroy?.();
    await collectorBrowserPlugin.initialize?.({
      logger: noopLogger as any,
      pluginConfig: { collectTimeoutSeconds: 30, browserStrategy: 'system-chrome' },
    });

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue('<html><body><article>Rendered</article></body></html>'),
      url: vi.fn().mockReturnValue('https://example.com/rendered'),
      close: vi.fn().mockResolvedValue(undefined),
      route: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);

    await collectorBrowserPlugin.collect(
      { url: 'https://example.com' },
      new AbortController().signal,
    );

    expect(chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, channel: 'chrome' }),
    );
  });

  it('auto strategy falls back to bundled Chromium when system Chrome launch fails', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue('<html><body><article>Rendered</article></body></html>'),
      url: vi.fn().mockReturnValue('https://example.com/rendered'),
      close: vi.fn().mockResolvedValue(undefined),
      route: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(chromium.launch)
      .mockRejectedValueOnce(new Error('no chrome'))
      .mockResolvedValueOnce(browser as any);

    const fbResult = await collectorBrowserPlugin.collect(
      { url: 'https://example.com' },
      new AbortController().signal,
    );

    expect(fbResult.metadata.collector_browserEngine).toBe('auto_fallback_bundled');
    expect(fbResult.metadata.collector_browserEngineLabel).toContain('Playwright');

    expect(chromium.launch).toHaveBeenCalledTimes(2);
    expect(chromium.launch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ headless: true, channel: 'chrome' }),
    );
    expect(chromium.launch).toHaveBeenNthCalledWith(2, expect.objectContaining({ headless: true }));
    expect(emitCollectDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining('fell back to Playwright-bundled Chromium'),
    );
  });

  it('maps aborted signal to ABORTED (not TIMEOUT)', async () => {
    const ac = new AbortController();
    ac.abort();
    const page = {
      goto: vi.fn(),
      waitForLoadState: vi.fn(),
      content: vi.fn(),
      url: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      route: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);

    await expect(
      collectorBrowserPlugin.collect({ url: 'https://example.com' }, ac.signal),
    ).rejects.toMatchObject({
      name: 'CollectorError',
      code: 'ABORTED',
      retryable: false,
    });
  });

  it('wraps Playwright timeout failures as retryable collector timeouts', async () => {
    const page = {
      goto: vi.fn().mockRejectedValue(new MockPlaywrightTimeoutError('navigation timeout')),
      close: vi.fn().mockResolvedValue(undefined),
      route: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);

    await expect(
      collectorBrowserPlugin.collect({ url: 'https://example.com' }, new AbortController().signal),
    ).rejects.toMatchObject({
      name: 'CollectorError',
      code: 'TIMEOUT',
      retryable: true,
    });
  });
});
