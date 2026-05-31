'use server';

import { GoldpanApiError } from '@goldpan/web-sdk';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createPublicClient, createServerClient, rethrowNextErrors } from '@/lib/api';
import { clearSessionCookie, setSessionCookie } from '@/lib/auth';

export type LoginState = {
  error?: string;
};

export async function loginAction(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const t = await getTranslations('auth');

  const password = formData.get('password');
  if (typeof password !== 'string' || !password) {
    return { error: t('password_required') };
  }

  try {
    const client = createPublicClient();
    const result = await client.login(password);
    if (!result.token) {
      return { error: t('login_failed') };
    }
    await setSessionCookie(result.token);
  } catch (err) {
    rethrowNextErrors(err);
    if (err instanceof GoldpanApiError) {
      if (err.status === 401) return { error: t('invalid_password') };
      if (err.status === 429) return { error: t('rate_limited') };
    }
    return { error: t('login_failed') };
  }

  redirect('/');
}

export async function logoutAction(): Promise<void> {
  try {
    const client = await createServerClient();
    await client.logout();
  } catch {
    // Best-effort server notification. We intentionally swallow ALL errors
    // here — including the `redirect('/login')` thrown by `onUnauthorized`
    // when the session is already expired — so that we always reach the
    // explicit cookie clear + redirect below. If we re-threw the redirect
    // here, the cookie would survive a logout-after-expiry and the user
    // would loop straight back into /login -> / -> /login.
  }
  await clearSessionCookie();
  redirect('/login');
}
