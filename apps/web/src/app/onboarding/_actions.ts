// apps/web/src/app/onboarding/_actions.ts
'use server';

import { cookies } from 'next/headers';
import type { SupportedLocale } from '@/i18n/locales';

const COOKIE_NAME = 'wizard-locale';

/**
 * Persist the wizard's language choice into a session cookie. The cookie is
 * read by apps/web/src/i18n/request.ts (with priority over the env-locked
 * locale) so subsequent wizard pages render in the chosen language.
 *
 * Cookie attributes:
 * - httpOnly: never read from JS — only the server reads it for SSR locale.
 * - sameSite=lax: standard CSRF stance for navigation cookies.
 * - secure in production: matches the rest of the app's cookie posture.
 * - No maxAge: session cookie. Once the wizard is committed and the server
 *   exits wizard mode, apps/web/src/middleware.ts lazy-clears the cookie on
 *   the next normal-mode response so the env language-lock takes over.
 */
export async function setWizardLocale(locale: SupportedLocale): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, locale, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}
