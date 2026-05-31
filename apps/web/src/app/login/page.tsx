import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createPublicClient, createTokenValidationClient } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/auth-edge';
import { LoginForm } from './login-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return { title: t('page_login') };
}

export default async function LoginPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  // Server's /auth/status is the single source of truth for both "auth
  // required?" and "is this token still valid?". One status RPC gives us
  // both, atomically (a stale `authRequired` cache hit followed by a
  // separate token-validation call could otherwise race the user just
  // toggling the password). Token-bearing requests use the validation
  // client (no onUnauthorized side-effect) so a 401 surfaces as an
  // exception instead of recursively redirecting back here.
  //
  // Probe failure → assume authRequired=true and render the form. We
  // deliberately do NOT fall back to `process.env.GOLDPAN_AUTH_PASSWORD`:
  // the env is snapshot at web boot and goes stale the moment the user
  // sets/clears the password through Settings, which was the exact bug
  // this page used to trigger as an infinite `/` ↔ `/login` loop. If the
  // server is genuinely down, showing the form is the safer default —
  // bouncing to `/` based on stale env would just hit the same outage
  // there and waste a navigation.
  let authRequired = true;
  let authenticated = false;
  try {
    const probeClient = token ? createTokenValidationClient(token) : createPublicClient();
    const status = await probeClient.getStatus();
    authRequired = status.authRequired;
    authenticated = status.authenticated;
  } catch (err) {
    // Keep defaults — render the form. Log the underlying reason so
    // self-host operators can diagnose why the probe failed (DNS, server
    // down, TLS misconfig) when users report "login page always shows the
    // form even though I disabled auth".
    console.warn('[login] /auth/status probe failed; defaulting to form', err);
  }

  // Either branch means "this user has no reason to see the login form" —
  // server doesn't require auth, or the token they already have is good.
  if (!authRequired || authenticated) redirect('/');
  // A stale token stays in the cookie jar until either `loginAction` overwrites
  // it on success or `logoutAction` clears it explicitly. Don't try to delete
  // it here — Next.js forbids cookie mutation from RSC, and the leftover token
  // is harmless: every authenticated request 401s and the SDK's onUnauthorized
  // bounces back to this page.

  const t = await getTranslations('auth');

  return (
    <div className="gp-login">
      <h1>{t('login_title')}</h1>
      <LoginForm />
    </div>
  );
}
