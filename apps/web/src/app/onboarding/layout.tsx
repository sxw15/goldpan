// apps/web/src/app/onboarding/layout.tsx
//
// Nested layout under the root layout. Do NOT render <html>/<body> here — the
// root layout (apps/web/src/app/layout.tsx) handles that, and skips its TopNav
// shell when pathname starts with /onboarding (see isOnboardingRoute branch).
//
// This layout adds the wizard-specific shell: progress bar across the 8 steps
// and a client-side state context (WizardStateProvider) that hydrates from
// /api/onboarding/state on mount and PATCHes back as users edit fields.
import type { ReactNode } from 'react';
import { WizardShell } from './_components/wizard-shell';

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  return <WizardShell>{children}</WizardShell>;
}
