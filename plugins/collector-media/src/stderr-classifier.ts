import type { CollectorErrorCode } from '@goldpan/core/plugins';

export interface StderrClassification {
  code: CollectorErrorCode;
  retryable: boolean;
}

export interface ClassifyOptions {
  logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => unknown };
}

export function classify(
  stderr: string,
  exitCode: number,
  opts: ClassifyOptions = {},
): StderrClassification | null {
  if (exitCode === 0) return null;

  const t = stderr.toLowerCase();

  if (t.includes('private video') || t.includes('video unavailable') || t.includes('removed by')) {
    return { code: 'NOT_FOUND', retryable: false };
  }
  if (
    t.includes('not available in your country') ||
    t.includes('login required') ||
    t.includes('members-only')
  ) {
    return { code: 'INVALID_REQUEST', retryable: false };
  }
  if (t.includes('http error 429') || t.includes('too many requests')) {
    return { code: 'RATE_LIMIT', retryable: true };
  }
  if (/http error 5\d{2}/.test(t)) {
    return { code: 'UPSTREAM', retryable: true };
  }
  if (/http error 4\d{2}/.test(t)) {
    return { code: 'NOT_FOUND', retryable: false };
  }
  if (
    t.includes('connection refused') ||
    t.includes('network is unreachable') ||
    t.includes('unable to download')
  ) {
    return { code: 'FETCH_FAILED', retryable: true };
  }

  // Unknown stderr: terminal=false to surface the failure mode (yt-dlp itself
  // broken, new YouTube error wording, etc.) instead of letting the worker
  // retry-storm against the same root cause.
  opts.logger?.warn?.(
    `unknown yt-dlp stderr (extend classifier?): exit=${exitCode}, ${stderr.slice(0, 500)}`,
  );
  return { code: 'FETCH_FAILED', retryable: false };
}
