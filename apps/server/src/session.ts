// apps/server/src/session.ts
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'goldpan_session';
export const SESSION_MAX_AGE_S = 86400; // 24 hours

/**
 * Generate an HMAC-SHA256 session token.
 * Format: `timestamp.nonce.signature`
 */
export function generateSessionToken(authPassword: string): string {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sessionKey = crypto.createHash('sha256').update(`goldpan-session:${authPassword}`).digest();
  const hmac = crypto.createHmac('sha256', sessionKey);
  hmac.update(`${timestamp}:${nonce}`);
  return `${timestamp}.${nonce}.${hmac.digest('hex')}`;
}

/**
 * Validate a session token.
 * Returns true if the token is valid and not expired.
 */
export function validateSessionToken(token: string, authPassword: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [timestamp, nonce, signature] = parts;

  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  if (!/^[0-9a-f]{32}$/.test(nonce)) return false;

  const age = Date.now() - parseInt(timestamp, 10);
  if (Number.isNaN(age) || age < 0 || age > SESSION_MAX_AGE_S * 1000) return false;

  const sessionKey = crypto.createHash('sha256').update(`goldpan-session:${authPassword}`).digest();
  const hmac = crypto.createHmac('sha256', sessionKey);
  hmac.update(`${timestamp}:${nonce}`);
  const expected = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Extract session token from request.
 * Checks: 1) Authorization: Bearer header, 2) Cookie header.
 */
export function extractSessionToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  // 1. Bearer token
  const authHeader = headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Cookie
  const cookieHeader = headers.cookie;
  if (typeof cookieHeader === 'string') {
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }

  return null;
}

/**
 * Build Set-Cookie header value for the session token.
 */
export function buildSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${SESSION_MAX_AGE_S}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Build Set-Cookie header value that expires the session cookie.
 */
export function buildSessionCookieClear(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
