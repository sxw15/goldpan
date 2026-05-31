// In-memory sliding-window rate limiter.
//
// The global limiter (RATE_WINDOW_MS / RATE_MAX_REQUESTS) gates unauthenticated
// HTTP traffic — authenticated requests bypass it (see main.ts handleRequest)
// so a single user's normal browsing doesn't trip the cap by sharing a
// loopback IP key with itself.
//
// `routes/auth.ts` builds its own limiter via `createSlidingWindowLimiter`
// for failed-login throttling (smaller window, smaller key cap).
import type http from 'node:http';

export interface SlidingWindowLimiter {
  /** Atomically check + record. Returns true if the call is under the cap. */
  tryConsume(key: string): boolean;
  /** Check without recording — for callers that bill failures only. */
  peek(key: string): boolean;
  /** Record an attempt at the current time. */
  record(key: string): void;
}

export interface SlidingWindowOptions {
  windowMs: number;
  max: number;
  maxKeys: number;
}

/**
 * Build an in-memory sliding-window limiter. Buckets are pruned in two ways:
 * 1. lazily, when a key is touched — expired entries are shifted out and
 *    nearby empty buckets are evicted.
 * 2. eagerly, when the bucket map hits `maxKeys` — a full sweep removes
 *    expired keys, falling back to oldest-inserted eviction if still at cap.
 */
export function createSlidingWindowLimiter(opts: SlidingWindowOptions): SlidingWindowLimiter {
  const { windowMs, max, maxKeys } = opts;
  const buckets = new Map<string, number[]>();

  function touch(key: string, now: number): number[] {
    const cutoff = now - windowMs;
    let timestamps = buckets.get(key);
    if (!timestamps) {
      if (buckets.size >= maxKeys) {
        for (const [k, v] of buckets) {
          if (v.length === 0 || v[v.length - 1] < cutoff) {
            buckets.delete(k);
          }
        }
        // Last resort if every bucket is still live — drop the oldest insert.
        if (buckets.size >= maxKeys) {
          const firstKey = buckets.keys().next().value;
          if (firstKey !== undefined) buckets.delete(firstKey);
        }
      }
      timestamps = [];
      buckets.set(key, timestamps);
    }
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    // Periodic sweep so empty buckets created by quiet keys eventually evict
    // (skip current key so we don't detach the local ref we just got).
    if (timestamps.length === 0 && buckets.size > 100) {
      for (const [k, v] of buckets) {
        if (k !== key && (v.length === 0 || v[v.length - 1] < cutoff)) buckets.delete(k);
      }
    }
    return timestamps;
  }

  return {
    tryConsume(key: string): boolean {
      const now = Date.now();
      const timestamps = touch(key, now);
      if (timestamps.length >= max) return false;
      timestamps.push(now);
      return true;
    },
    peek(key: string): boolean {
      const timestamps = touch(key, Date.now());
      return timestamps.length < max;
    },
    record(key: string): void {
      const now = Date.now();
      const timestamps = touch(key, now);
      timestamps.push(now);
    },
  };
}

const RATE_WINDOW_MS = 60_000;
// 600 req/min = 10 req/sec average。原来 30 太紧 — 一次 wizard 页面加载 +
// Next dev StrictMode 双渲染 + 用户连续点击就能逼近,interactive UI 不该
// 在正常使用下触发 rate limit。10/sec 在防 CPU 失控的层面已经足够宽松,
// 真正的 brute-force 防护各路由(login / IM webhook)有自己的 limiter。
//
// Exported so `tests/rate-limit.test.ts` brute-force assertion stays in sync
// with the production cap — when this number changes, the test follows
// automatically instead of silently asserting against a stale constant.
export const RATE_MAX_REQUESTS = 600;
const RATE_MAX_KEYS = 10_000;

const globalLimiter = createSlidingWindowLimiter({
  windowMs: RATE_WINDOW_MS,
  max: RATE_MAX_REQUESTS,
  maxKeys: RATE_MAX_KEYS,
});

export function checkRateLimit(key: string): boolean {
  return globalLimiter.tryConsume(key);
}

let trustProxy = false;

export function setTrustProxy(b: boolean): void {
  trustProxy = b;
}

export function getRateLimitKey(req: http.IncomingMessage): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}
