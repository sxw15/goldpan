import { describe, expect, it, vi } from 'vitest';
import { collectorMediaPlugin } from '../src/index';

describe('plugin lifecycle', () => {
  it('initializes with minimal config', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };
    await collectorMediaPlugin.initialize?.({
      logger: logger as never,
      pluginConfig: {
        dataDir: '/tmp/test-data',
        mediaCollectTimeoutSeconds: 90,
        ytDlpAutoUpdate: false,
      },
    });
    expect(logger.info).toHaveBeenCalled();
    expect(collectorMediaPlugin.getCollectTimeoutMs?.()).toBe(90_000);
    await collectorMediaPlugin.destroy?.();
  });

  it('canHandle accepts whitelisted URL', () => {
    expect(collectorMediaPlugin.canHandle({ url: 'https://youtube.com/watch?v=x' })).toBe(true);
    expect(collectorMediaPlugin.canHandle({ url: 'https://example.com/' })).toBe(false);
  });

  it('cookies path warning when file unreadable', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };
    await collectorMediaPlugin.initialize?.({
      logger: logger as never,
      pluginConfig: {
        dataDir: '/tmp/test-data',
        ytDlpCookiesPath: '/nonexistent/cookies.txt',
        ytDlpAutoUpdate: false,
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not readable'));
    await collectorMediaPlugin.destroy?.();
  });
});
