// apps/web/src/app/onboarding/_components/use-wizard-commit.ts
//
// Shared commit gateway for the onboarding wizard. Extracted from
// `auth/_form.tsx` so the last *visible* step (currently IM, see steps.ts)
// can also drive the commit. The auth route file stays on disk for direct
// URL access and reuses this hook.
//
// Drains pending PATCHes via `flush()` first — otherwise the last keystroke
// can race the commit and the server reads stale wizard state.
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useWizard } from './wizard-state';

export interface CommitErrorEntry {
  path?: string | (string | number)[];
  message?: string;
}

interface CommitOk {
  kind: 'ok';
  ok: true;
  metadataSeedFailed?: true;
}

interface CommitErrors {
  kind: 'errors';
  ok: false;
  errors: CommitErrorEntry[];
}

type CommitResult = CommitOk | CommitErrors;

export interface UseWizardCommit {
  commit: () => Promise<void>;
  committing: boolean;
  submitFailed: boolean;
  validationErrors: CommitErrorEntry[] | null;
  resetSubmitFailed: () => void;
}

export function useWizardCommit(): UseWizardCommit {
  const router = useRouter();
  const { flush } = useWizard();
  const [committing, setCommitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [validationErrors, setValidationErrors] = useState<CommitErrorEntry[] | null>(null);

  async function commit() {
    setCommitting(true);
    setSubmitFailed(false);
    setValidationErrors(null);
    try {
      // Drain any pending PATCH (last keystroke might still be in flight)
      // before committing — otherwise the server's commit handler could
      // read stale wizard state.
      await flush();
    } catch {
      // patch already set patchError; wizard-shell banner is showing.
      setCommitting(false);
      return;
    }
    try {
      const r = await fetch('/api/onboarding/commit', { method: 'POST' });
      // 5xx is a hard failure (network drop, proxy down) — bail before trying
      // to parse a body that won't exist or won't be JSON.
      if (!r.ok && r.status >= 500) {
        setSubmitFailed(true);
        return;
      }
      const data = (await r.json()) as CommitResult;
      // Body-shape check guards against 4xx (or 200) with JSON whose `kind`
      // doesn't match a known branch.
      if (data?.kind === 'ok') {
        // The seed-failed signal travels via query string — we need to surface
        // it on the success page (one-time render), not persist it.
        // router.replace prevents the user from hitting Back here and
        // re-submitting.
        const qs = data.metadataSeedFailed ? '?seed_failed=1' : '';
        router.replace(`/onboarding/complete${qs}`);
      } else if (data?.kind === 'errors') {
        setValidationErrors(data.errors);
      } else {
        setSubmitFailed(true);
      }
    } catch {
      // Network drop or invalid JSON — surface to user instead of silently
      // re-enabling the button as if nothing happened.
      setSubmitFailed(true);
    } finally {
      setCommitting(false);
    }
  }

  return {
    commit,
    committing,
    submitFailed,
    validationErrors,
    resetSubmitFailed: () => setSubmitFailed(false),
  };
}

export function formatErrorPath(path: CommitErrorEntry['path']): string {
  if (Array.isArray(path)) return path.join('.');
  return path ?? '';
}
