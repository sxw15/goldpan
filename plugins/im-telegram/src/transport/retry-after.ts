import type { ILogObj, Logger } from 'tslog';

const DEFAULT_MAX_RETRIES = 3;

interface TelegramRateLimitErrorShape {
  error_code?: unknown;
  parameters?: {
    retry_after?: unknown;
  };
}

function createAbortError(): Error {
  const err = new Error('Aborted while waiting to retry Telegram API call');
  err.name = 'AbortError';
  return err;
}

function getRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as TelegramRateLimitErrorShape;
  if (candidate.error_code !== 429) return null;
  const retryAfter = candidate.parameters?.retry_after;
  if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    return null;
  }
  return Math.ceil(retryAfter * 1000);
}

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw createAbortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withTelegramRetryAfter<T>(
  operation: () => Promise<T>,
  opts: {
    logger: Logger<ILogObj>;
    signal?: AbortSignal;
    maxRetries?: number;
  },
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; ; attempt += 1) {
    if (opts.signal?.aborted) throw createAbortError();
    try {
      return await operation();
    } catch (error) {
      const retryAfterMs = getRetryAfterMs(error);
      if (retryAfterMs === null || attempt >= maxRetries) {
        throw error;
      }
      opts.logger.info('Telegram API rate limited, retrying', {
        attempt: attempt + 1,
        retryAfterMs,
      });
      await waitForRetry(retryAfterMs, opts.signal);
    }
  }
}
