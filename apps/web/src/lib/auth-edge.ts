export const SESSION_COOKIE = 'goldpan_session';

/**
 * Check if the session cookie is present in the cookie header string.
 * This is a presence check only — the server validates the token.
 * Designed for Edge Runtime (middleware) — no async, no crypto, no Node APIs.
 */
export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(';').some((c) => c.trim().startsWith(`${SESSION_COOKIE}=`));
}
