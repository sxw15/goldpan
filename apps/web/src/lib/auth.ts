import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from './auth-edge';
import { probeAuthRequired } from './auth-probe';

const SESSION_MAX_AGE = 86400; // 24 hours in seconds

/**
 * Require authentication. Redirects to /login if auth is enabled and no session cookie.
 * Call at the top of server components and server actions that need auth.
 * Note: If the cookie exists but the token is expired/invalid, the first SDK call
 * will receive a 401 → GoldpanClient.onUnauthorized → redirect('/login').
 *
 * "Is auth required?" comes from probeAuthRequired() (server's /auth/status) and
 * NOT from process.env.GOLDPAN_AUTH_PASSWORD — see lib/auth-probe.ts for the
 * stale-env rationale.
 */
export async function requireAuth(): Promise<void> {
  const { authRequired } = await probeAuthRequired();
  if (!authRequired) return;
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');
}

/**
 * Set the session cookie after a successful login.
 * Called by loginAction after receiving a token from the server.
 */
export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}

/**
 * Clear the session cookie on logout.
 */
export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}
