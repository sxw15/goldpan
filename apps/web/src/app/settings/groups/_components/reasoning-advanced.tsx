'use client';

import {
  inferTierFromOptions,
  PROVIDERS_WITH_OPTIONS,
  type ProviderWithOptions,
  REASONING_TIERS,
  type ReasoningTier,
  TIER_TO_PROVIDER_OPTIONS,
} from '@goldpan/core/llm/reasoning-tiers';
import type { EnvKeyState } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Btn } from '@/components/ui/button';
import { rethrowNextErrors } from '@/lib/rethrow';

interface Props {
  /** UI step id (snake_case, e.g. 'digest_summary'). Uppercased into the env segment. */
  stepId: string;
  /** Currently selected provider id from the row's provider dropdown. May be a non-builtin
   * provider (ollama / plugin / custom) — handled with an unsupported notice. */
  provider: string;
  env: ReadonlyMap<string, EnvKeyState>;
  /** Per-field auto-commit driver. Replaces the legacy `patch` + SaveBar
   *  path so a tier-tab click lands on the server immediately. */
  commit: (
    patch: Record<string, string | null>,
  ) => Promise<import('@goldpan/web-sdk').CommitEnvResult>;
  resetEnvKey: (key: string) => Promise<boolean>;
  /** When true, the row's provider is still pending (user picked but
   * model not yet chosen). ReasoningAdvanced commits OPTIONS keyed by
   * provider — committing to the still-pending provider's options
   * orphans the value if the user later picks a different provider.
   * Lock the select while pending so the user must commit a model
   * first. */
  providerLocked?: boolean;
}

function isReasoningProvider(p: string): p is ProviderWithOptions {
  return (PROVIDERS_WITH_OPTIONS as readonly string[]).includes(p);
}

function reasoningEnvKey(stepId: string, provider: ProviderWithOptions): string {
  return `GOLDPAN_LLM_${stepId.toUpperCase()}_${provider.toUpperCase()}_OPTIONS`;
}

function readEffectiveTier(
  envKey: string,
  provider: ProviderWithOptions,
  env: ReadonlyMap<string, EnvKeyState>,
): { tier: ReasoningTier | 'unknown'; source: 'env' | 'override' | 'default' } {
  const state = env.get(envKey);
  const raw = state?.mask ?? '';
  if (raw === '') {
    return { tier: 'off', source: state?.source ?? 'default' };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const obj = JSON.parse(raw);
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      parsed = obj as Record<string, unknown>;
    }
  } catch {
    return { tier: 'unknown', source: state?.source ?? 'default' };
  }
  return {
    tier: inferTierFromOptions(parsed, provider),
    source: state?.source ?? 'default',
  };
}

export function ReasoningAdvanced({
  stepId,
  provider,
  env,
  commit,
  resetEnvKey,
  providerLocked,
}: Props) {
  const t = useTranslations('settings.llm.reasoning');
  const [resetting, setResetting] = useState(false);
  // Track whether a tier commit is in flight so we lock both the select
  // and the reset button — fast-clicking through 3 tiers can otherwise
  // produce out-of-order resolves (older response writes back after
  // newer), stranding the row on the second-to-last pick.
  const [committingTier, setCommittingTier] = useState(false);

  if (provider === '') return null;

  if (!isReasoningProvider(provider)) {
    return (
      <details className="gp-llm-step-row__advanced">
        <summary className="gp-llm-step-row__advanced-summary">{t('advanced_summary')}</summary>
        <div className="gp-llm-step-row__advanced-body gp-llm-step-row__advanced-body--disabled">
          {t('unsupported_provider', { provider })}
        </div>
      </details>
    );
  }

  const envKey = reasoningEnvKey(stepId, provider);
  const { tier, source } = readEffectiveTier(envKey, provider, env);
  const isOverride = source === 'override';
  const isUnknown = tier === 'unknown';

  const summaryLabel =
    tier === 'off' || isUnknown
      ? t('advanced_summary')
      : t('advanced_summary_with_tier', { tier: t(`tier_${tier}`) });

  const onChange = async (next: ReasoningTier) => {
    setCommittingTier(true);
    try {
      if (next === 'off') {
        await resetEnvKey(envKey);
        return;
      }
      const opts = TIER_TO_PROVIDER_OPTIONS[next][provider];
      if (opts === null) {
        await resetEnvKey(envKey);
        return;
      }
      await commit({ [envKey]: JSON.stringify(opts) }).catch(rethrowNextErrors);
    } finally {
      setCommittingTier(false);
    }
  };

  const onResetClick = async () => {
    setResetting(true);
    try {
      await resetEnvKey(envKey);
    } finally {
      setResetting(false);
    }
  };

  const selectLocked = providerLocked === true || committingTier;

  return (
    // Default open whenever the row has *any* override (including unknown),
    // so a hand-rolled JSON outside the ladder surfaces "Custom (env)" in the
    // user's main view instead of hiding behind a folded "Advanced" summary.
    <details className="gp-llm-step-row__advanced" open={isOverride}>
      <summary className="gp-llm-step-row__advanced-summary">{summaryLabel}</summary>
      <div className="gp-llm-step-row__advanced-body">
        <div className="gp-llm-step-row__advanced-row">
          <span className="gp-llm-step-row__advanced-label">{t('label')}</span>
          {isUnknown ? (
            <>
              <span className="gp-llm-step-row__advanced-custom">{t('custom_locked')}</span>
              <Btn sm kind="ghost" disabled={resetting} onClick={onResetClick}>
                {resetting ? t('reset_in_progress') : t('reset_to_off')}
              </Btn>
            </>
          ) : (
            <select
              className="gp-sselect"
              aria-label={t('select_aria')}
              value={tier}
              disabled={selectLocked}
              onChange={(e) => void onChange(e.target.value as ReasoningTier)}
            >
              {REASONING_TIERS.map((tt) => (
                <option key={tt} value={tt}>
                  {t(`tier_${tt}`)}
                </option>
              ))}
            </select>
          )}
        </div>
        {isUnknown ? (
          <p className="gp-llm-step-row__advanced-hint">{t('custom_hint', { envKey })}</p>
        ) : null}
      </div>
    </details>
  );
}
