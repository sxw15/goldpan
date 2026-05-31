// apps/server/src/routes/onboarding/_body.ts
import type http from 'node:http';
import { respondError } from '../types.js';

const MAX_BODY_BYTES = 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;

/**
 * Read a request body to a string with a 1 MB cap and 10 s timeout. Returns
 * null if the helper already wrote a 413 / 408 response — caller must stop
 * (do not write a second response).
 *
 * The wizard server runs as a tiny standalone HTTP listener (not the main
 * `RouteContext`-based server), so onboarding routes can't reuse
 * `ctx.readBody`. This helper is the local equivalent — kept self-contained
 * so the wizard server stays trivially testable.
 */
export async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let resolved = false;
    const settle = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      respondError(res, 408, 'request_timeout', 'Body read timed out');
      req.resume();
      settle(null);
    }, BODY_READ_TIMEOUT_MS);
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        clearTimeout(timer);
        respondError(res, 413, 'payload_too_large', 'Body exceeds 1 MB');
        req.resume();
        settle(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      settle(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      clearTimeout(timer);
      settle(null);
    });
  });
}
