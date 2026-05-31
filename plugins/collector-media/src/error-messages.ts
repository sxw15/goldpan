import type { CollectorErrorCode } from '@goldpan/core/plugins';

export type ErrorContext = {
  siteName: string;
  videoId?: string;
  lang?: string;
};

const id = (c: ErrorContext) => c.videoId ?? '(unknown id)';

export const ERROR_MESSAGES: Record<CollectorErrorCode, (c: ErrorContext) => string> = {
  NOT_FOUND: (c) => `${c.siteName} video ${id(c)} unavailable (deleted / private / not public)`,
  INVALID_REQUEST: (c) =>
    `${c.siteName} video ${id(c)} requires login / membership / blocked by region (try setting GOLDPAN_YT_DLP_COOKIES_PATH)`,
  RATE_LIMIT: (c) => `${c.siteName} rate-limited, retry later`,
  UPSTREAM: (c) => `${c.siteName} upstream error (HTTP 5xx), retry later`,
  CONTENT_EMPTY: (c) =>
    `${c.siteName} video ${id(c)} has no ${c.lang ?? 'en'}/en subtitles available`,
  FETCH_FAILED: (c) => `${c.siteName} video fetch failed (network / binary)`,
  PARSE_FAILED: (c) => `${c.siteName} video metadata parse failed`,
  TIMEOUT: (c) => `${c.siteName} video collection timed out`,
  ABORTED: (c) => `${c.siteName} video collection aborted`,
};
