// packages/web-sdk/src/errors.ts

/**
 * Error thrown by GoldpanClient on non-2xx API responses.
 * `code` is machine-readable (e.g. 'unauthorized', 'rate_limited', 'not_found').
 * `status` is the HTTP status code (0 for network errors).
 */
export class GoldpanApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly data: Record<string, unknown> | null;

  constructor(
    message: string,
    code: string,
    status: number,
    data: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'GoldpanApiError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}
