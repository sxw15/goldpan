// apps/web/src/app/onboarding/_components/wizard-shell.tsx
'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Btn } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ProgressBar } from './progress-bar';
import { useWizard, WizardStateProvider } from './wizard-state';

/**
 * Pages that need a wider shell because they render a sidebar alongside the
 * main column. The default 768px container leaves only ~500px for main once
 * the 240px aside is subtracted — too cramped for the provider/step cards.
 */
const WIDE_PATHS = new Set<string>(['/onboarding/pipeline']);

/**
 * Wizard outer shell. Wraps every /onboarding/* page with:
 * - WizardStateProvider: client-side mirror of the wizard server's state, with
 *   on-mount hydration from /api/onboarding/state and PATCH-back via patch().
 * - ProgressBar: 8-step indicator derived from pathname.
 * - <PatchErrorBanner>: visible warning whenever hydrate or PATCH silently
 *   fails, so the user doesn't lose input without knowing.
 *
 * The narrow .gp-onboarding container matches the wizard's form-heavy nature —
 * the user is filling in keys / models / toggles, not browsing wide content.
 */
export function WizardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const wide = WIDE_PATHS.has(pathname);
  return (
    <WizardStateProvider>
      <div className={wide ? 'gp-onboarding gp-onboarding--wide' : 'gp-onboarding'}>
        <header className="gp-onboarding__head">
          <ProgressBar />
        </header>
        <PatchErrorBanner />
        <main className="gp-onboarding__main">{children}</main>
      </div>
    </WizardStateProvider>
  );
}

function PatchErrorBanner() {
  const t = useTranslations('onboarding');
  const { patchError, dismissError } = useWizard();
  if (!patchError) return null;
  const titleKey =
    patchError === 'hydrate' ? 'shell_error_hydrate_title' : 'shell_error_patch_title';
  const bodyKey = patchError === 'hydrate' ? 'shell_error_hydrate_body' : 'shell_error_patch_body';
  return (
    <div className="gp-onboarding__banner">
      <Notice
        kind="warn"
        heading={t(titleKey)}
        trailing={
          <Btn kind="ghost" sm onClick={dismissError}>
            {t('shell_error_dismiss')}
          </Btn>
        }
      >
        {t(bodyKey)}
      </Notice>
    </div>
  );
}
