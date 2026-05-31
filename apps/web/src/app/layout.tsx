import { Inter, Noto_Sans_SC } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { CmdKProvider } from '@/components/cmdk-provider';
import { ConfirmProvider } from '@/components/confirm-provider';
import { MobileTabbar } from '@/components/mobile-tabbar';
import { ThemeProvider } from '@/components/theme-provider';
import { TopNav } from '@/components/top-nav';
import { TzProvider } from '@/components/tz-provider';
import { probeDigestPluginEnabled } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/auth-edge';
import { probeAuthRequired } from '@/lib/auth-probe';
import { themeInitScript } from '@/lib/theme-script';
import { getEffectiveTimezone } from '@/lib/tz-fetch';

import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const notoSansSC = Noto_Sans_SC({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-noto-sc',
  display: 'swap',
});

export async function generateMetadata() {
  const t = await getTranslations('metadata');
  return {
    title: { default: t('app_title'), template: `%s | ${t('app_title')}` },
    description: t('app_description'),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const tz = await getEffectiveTimezone();
  const h = await headers();
  const pathname = h.get('x-pathname') ?? '';
  const isShareRoute = pathname.startsWith('/digest/share/');
  const isOnboardingRoute = pathname.startsWith('/onboarding');
  // /login is pre-auth too: token cookie may be stale (RSC can't clear it),
  // and surfacing nav/Logout while the user is on the login form makes the
  // page look authed and lets the user click into pages that immediately
  // 401-bounce back here.
  const isLoginRoute = pathname.startsWith('/login');

  // Skip nav/shell entirely for public share pages and the onboarding wizard.
  // Onboarding pages are pre-auth — wizard mode runs without sessions, so a
  // logout button or settings link in the nav would 401. The wizard provides
  // its own shell (progress bar + state context) via /onboarding/layout.tsx.
  // All provider wrappers (ThemeProvider, NextIntlClientProvider) are still
  // rendered so child components can use themes and translations.
  if (isShareRoute || isOnboardingRoute || isLoginRoute) {
    return (
      <html
        lang={locale}
        className={`${inter.variable} ${notoSansSC.variable}`}
        suppressHydrationWarning
      >
        <head>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static FOUC-prevention script from themeInitScript, not user input */}
          <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        </head>
        <body>
          <TzProvider tz={tz}>
            <ThemeProvider>
              <NextIntlClientProvider messages={messages}>
                <ConfirmProvider>{children}</ConfirmProvider>
              </NextIntlClientProvider>
            </ThemeProvider>
          </TzProvider>
        </body>
      </html>
    );
  }

  const cookieStore = await cookies();
  // Cookie presence check only — token validation is deferred to requireAuth() on each page.
  // Expired sessions may briefly show the nav bar before redirect; this is acceptable
  // to avoid crypto operations in every layout render.
  const hasSession = cookieStore.has(SESSION_COOKIE);
  // Nav-badge + auth probes are independent of the three translation fetches;
  // batch them concurrently. probeAuthRequired() asks the server directly so
  // a runtime password change is reflected without restarting web (see
  // lib/auth-probe.ts). probeDigestPluginEnabled() is called unconditionally —
  // it short-circuits on its own when unauthenticated, and folding showNav
  // into a sequential pre-step here would add a round-trip; the "wasted"
  // call only happens on pre-login pages, where overall load count is tiny.
  const [tNav, tMeta, tDigest, digestProbe, authProbe] = await Promise.all([
    getTranslations('nav'),
    getTranslations('metadata'),
    getTranslations('digest'),
    probeDigestPluginEnabled(),
    probeAuthRequired(),
  ]);
  const authDisabled = !authProbe.authRequired;
  const showNav = hasSession || authDisabled;
  const digestDisabled = showNav && digestProbe?.enabled === false;

  return (
    <html
      lang={locale}
      className={`${inter.variable} ${notoSansSC.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static FOUC-prevention script from themeInitScript, not user input */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <TzProvider tz={tz}>
          <ThemeProvider>
            <NextIntlClientProvider messages={messages}>
              <ConfirmProvider>
                {showNav ? (
                  <div className="gp-shell">
                    <CmdKProvider>
                      <TopNav
                        appTitle={tMeta('app_title')}
                        chatLabel={tNav('chat')}
                        libraryLabel={tNav('library')}
                        trackingLabel={tNav('tracking')}
                        digestLabel={tNav('digest')}
                        digestDisabledBadge={digestDisabled ? tDigest('nav_badge_disabled') : null}
                        cmdkButtonLabel={tNav('cmdk_button')}
                        settingsLabel={tNav('settings')}
                        logoutLabel={tNav('logout')}
                        tasksLabel={tNav('tasks')}
                        conversationsLabel={tNav('conversations')}
                        showLogout={hasSession && !authDisabled}
                      />
                      <main className="gp-main">{children}</main>
                      <MobileTabbar
                        chatLabel={tNav('chat')}
                        libraryLabel={tNav('library')}
                        trackingLabel={tNav('tracking')}
                        digestLabel={tNav('digest')}
                        tasksLabel={tNav('tasks')}
                        navLabel={tNav('mobile_label')}
                      />
                    </CmdKProvider>
                  </div>
                ) : (
                  <main className="gp-main">{children}</main>
                )}
              </ConfirmProvider>
            </NextIntlClientProvider>
          </ThemeProvider>
        </TzProvider>
      </body>
    </html>
  );
}
