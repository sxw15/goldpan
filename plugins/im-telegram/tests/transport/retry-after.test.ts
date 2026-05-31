import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTelegramRetryAfter } from '../../src/transport/retry-after.js';

describe('withTelegramRetryAfter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries after Telegram 429 retry_after and then succeeds', async () => {
    vi.useFakeTimers();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never;
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({
        error_code: 429,
        parameters: { retry_after: 2 },
      })
      .mockResolvedValueOnce('ok');

    const pending = withTelegramRetryAfter(send, { logger, maxRetries: 2 });

    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toBe('ok');
    expect(send).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith('Telegram API rate limited, retrying', {
      attempt: 1,
      retryAfterMs: 2000,
    });
  });

  it('does not retry non-429 errors', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never;
    const error = new Error('boom');
    const send = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(withTelegramRetryAfter(send, { logger })).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('rethrows when Telegram keeps rate limiting past maxRetries', async () => {
    vi.useFakeTimers();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never;
    const error = {
      error_code: 429,
      parameters: { retry_after: 1 },
    };
    const send = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    const pending = withTelegramRetryAfter(send, { logger, maxRetries: 1 });
    const assertion = expect(pending).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(send).toHaveBeenCalledTimes(2);
  });
});
