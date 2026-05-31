// apps/server/src/auth.ts
import crypto from 'node:crypto';
import type http from 'node:http';
import { extractSessionToken, validateSessionToken } from './session.js';

const AUTH_HMAC_KEY = 'goldpan-server-auth';

/**
 * Legacy Bearer password check: the caller sends `Authorization: Bearer <password>`.
 * Kept for backward-compatible API clients that predate the session-cookie flow.
 */
export function verifyBearerAuth(req: http.IncomingMessage, password: string): boolean {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const tokenDigest = crypto.createHmac('sha256', AUTH_HMAC_KEY).update(token).digest();
  const expectedDigest = crypto.createHmac('sha256', AUTH_HMAC_KEY).update(password).digest();
  return crypto.timingSafeEqual(tokenDigest, expectedDigest);
}

/**
 * Unified auth check. Accepts both:
 *   1. Direct password as Bearer token (legacy API clients)
 *   2. Session token (cookie or Bearer) issued by `/auth/login`
 *
 * Shared by `main.ts` (protected routes) and `auth.ts` (`/auth/status`) so
 * both endpoints recognize the same set of credentials.
 */
export function verifyAuth(req: http.IncomingMessage, password: string): boolean {
  if (verifyBearerAuth(req, password)) return true;

  const token = extractSessionToken(req.headers as Record<string, string | string[] | undefined>);
  if (token && validateSessionToken(token, password)) return true;

  return false;
}
