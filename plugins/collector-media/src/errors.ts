import { CollectorError, type CollectorErrorCode } from '@goldpan/core/plugins';

/**
 * collector-media 所有失败统一 terminal=true：canHandle 命中视频白名单 = 此 URL
 * 是视频源的 positive identification。失败时不应 fallback 到 collector-browser/web
 * （它们对视频 URL 拿到的是播放器 SPA shell，对 pipeline 是噪音）。
 */
export function fail(
  code: CollectorErrorCode,
  message: string,
  retryable: boolean,
  cause?: unknown,
): CollectorError {
  return new CollectorError(message, code, retryable, cause, /* terminal */ true);
}

export function wrapAsTerminal(
  error: unknown,
  fallbackMessage = 'collector-media internal error',
): CollectorError {
  if (error instanceof CollectorError) {
    const ce: CollectorError = error;
    if (ce.terminal) return ce;
    // 非 terminal 强制 terminal=true（视频 collector 合同）；
    // 把整个 ce 作为 cause 而非 ce.cause，保留中间层 stack
    return new CollectorError(ce.message, ce.code, ce.retryable, ce, true);
  }
  const message = error instanceof Error ? error.message : String(error);
  return fail('FETCH_FAILED', `${fallbackMessage}: ${message}`, true, error);
}
