'use client';

import type { EnvKeyState } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Btn } from '@/components/ui/button';
import { SettingsField } from '@/components/ui/settings-field';
import { useEditableCommit } from '@/components/ui/use-field-commit';
import { LLM_STEPS } from '../../llm-steps';
import { useFieldTagLabels } from '../../use-field-tag-labels';

/** Mirrors core's `GOLDPAN_LLM_TIMEOUT` zod default (600s). Used only as the
 * fallback placeholder when env-state hasn't loaded yet — once env is hydrated
 * we display the real effective global value so users always see the actual
 * fallback their per-step inputs inherit. */
const GLOBAL_LLM_TIMEOUT_DEFAULT_SECONDS = 600;
/** Per-step / global timeout input bounds (matches core's zod schema). */
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 600;

const GLOBAL_TIMEOUT_KEY = 'GOLDPAN_LLM_TIMEOUT';

interface Props {
  env: ReadonlyMap<string, EnvKeyState>;
  /** Per-field auto-commit driver. Each keystroke fires commitEnv; empty
   *  string is normalised to null by settings-shell's commit wrapper so
   *  clearing the input resets the override the same way as the Reset
   *  button. */
  commit: (
    patch: Record<string, string | null>,
  ) => Promise<import('@goldpan/web-sdk').CommitEnvResult>;
  resetEnvKey: (key: string) => Promise<boolean>;
  setFieldEditing: (key: string, editing: boolean) => void;
}

/** Effective global timeout currently in force, used as the per-step input
 * placeholder so users see what their per-step inputs fall back to when
 * left empty. Defaults to zod-default when env-state is empty. */
function readGlobalTimeoutDisplay(env: ReadonlyMap<string, EnvKeyState>): string {
  const mask = env.get(GLOBAL_TIMEOUT_KEY)?.mask;
  if (mask !== undefined && mask !== '') return mask;
  return String(GLOBAL_LLM_TIMEOUT_DEFAULT_SECONDS);
}

function isInvalidTimeoutValue(value: string): boolean {
  if (value === '') return false;
  const n = Number(value);
  if (Number.isNaN(n)) return true;
  if (!Number.isInteger(n)) return true;
  if (n < MIN_TIMEOUT_SECONDS) return true;
  if (n > MAX_TIMEOUT_SECONDS) return true;
  return false;
}

/** Compact row used inside the collapsible per-step timeout section. Keeps
 * label/input/unit/reset aligned in a fixed grid so all 10 step rows scan
 * vertically without the busy provider/model row layout. */
function StepTimeoutRow({
  stepId,
  envKey,
  label,
  globalDisplay,
  env,
  commit,
  resetEnvKey,
  setFieldEditing,
}: {
  stepId: string;
  envKey: string;
  label: string;
  globalDisplay: string;
  env: ReadonlyMap<string, EnvKeyState>;
  commit: (
    patch: Record<string, string | null>,
  ) => Promise<import('@goldpan/web-sdk').CommitEnvResult>;
  resetEnvKey: (key: string) => Promise<boolean>;
  setFieldEditing: (key: string, editing: boolean) => void;
}) {
  const tMatrix = useTranslations('settings.llm.matrix');
  const tActions = useTranslations('settings.actions');
  const [resetting, setResetting] = useState(false);
  const state = env.get(envKey);
  // useEditableCommit drives blur-on-commit (not per-keystroke) — typing
  // "120" must NOT fire three commits, each rejected mid-way for being
  // out of [1, 600] or 0 from the coerce step. The hook also gives us a
  // cancel path so Escape reverts to env baseline.
  const hook = useEditableCommit({
    envKey,
    committed: state?.mask ?? '',
    commit,
    fieldName: label,
    baselineDiffers: state?.baselineDiffers,
    onEditingChange: (editing) => setFieldEditing(envKey, editing),
  });
  const showReset = state?.source === 'override' && hook.state !== 'saving';
  const invalid = isInvalidTimeoutValue(hook.draft);

  const onReset = async () => {
    setResetting(true);
    try {
      const ok = await resetEnvKey(envKey);
      if (ok) hook.clear();
      // Pre-fix this used tMatrix('reset_label') — the BUTTON label
      // ('Reset' / '重置') — which surfaces as the inline FieldStatus
      // error text. Every other migration site uses
      // tActions('reset_failed_inline') ('Reset failed — override still
      // active'); we mirror that for a meaningful error.
      else hook.markError(tActions('reset_failed_inline'));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="gp-llm-timeout-row" data-step={stepId}>
      <label className="gp-llm-timeout-row__label" htmlFor={`gp-llm-timeout-${stepId}`}>
        {label}
      </label>
      <input
        id={`gp-llm-timeout-${stepId}`}
        type="number"
        className="gp-sinput gp-llm-timeout-row__input"
        aria-label={tMatrix('timeout_input_aria', { step: label })}
        placeholder={globalDisplay}
        value={hook.draft}
        min={MIN_TIMEOUT_SECONDS}
        max={MAX_TIMEOUT_SECONDS}
        step={1}
        inputMode="numeric"
        disabled={hook.state === 'saving'}
        onChange={(e) => hook.setDraft(e.target.value)}
        onBlur={() => {
          if (hook.dirty) void hook.save();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            // No blur — see collect.tsx FieldNumber for the cancel/blur
            // race rationale.
            hook.cancel();
          }
        }}
      />
      <span className="gp-llm-timeout-row__unit">{tMatrix('timeout_unit')}</span>
      <span className="gp-llm-timeout-row__reset">
        {showReset ? (
          <Btn sm kind="ghost" disabled={resetting} onClick={onReset}>
            {resetting ? tMatrix('reset_in_progress_label') : tMatrix('reset_label')}
          </Btn>
        ) : null}
      </span>
      {invalid ? (
        <span className="gp-llm-timeout-row__warn">
          {tMatrix('timeout_invalid', {
            min: String(MIN_TIMEOUT_SECONDS),
            max: String(MAX_TIMEOUT_SECONDS),
          })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * LLM timeout configuration panel. Two parts:
 *
 * 1. Global timeout row (always visible) — `GOLDPAN_LLM_TIMEOUT`. Every step
 *    falls back to this when not individually overridden.
 * 2. Collapsible "per-step overrides (advanced)" section — one compact row
 *    per LLM step. Hidden by default to keep the model matrix scanable; the
 *    summary shows how many steps currently have an override so users see
 *    drift at a glance without expanding.
 *
 * Rationale: the previous "input on every PipelineStepRow" design crammed
 * provider/model/timeout into the same value cell and pushed step labels
 * into vertical-single-char columns on conditional rows. Splitting timeout
 * into its own panel lets the matrix card breathe and surfaces the global
 * default — the value 90% of users actually care about.
 */
export function LlmTimeoutPanel({ env, commit, resetEnvKey, setFieldEditing }: Props) {
  const t = useTranslations('settings.llm');
  const tMatrix = useTranslations('settings.llm.matrix');
  const fieldTagLabels = useFieldTagLabels();

  const globalState = env.get(GLOBAL_TIMEOUT_KEY);
  const tActions = useTranslations('settings.actions');
  // useEditableCommit on the global timeout for the same blur-on-commit
  // behaviour as the per-step rows below.
  const globalHook = useEditableCommit({
    envKey: GLOBAL_TIMEOUT_KEY,
    committed: globalState?.mask ?? '',
    commit,
    fieldName: t('timeout_global_label'),
    baselineDiffers: globalState?.baselineDiffers,
    onEditingChange: (editing) => setFieldEditing(GLOBAL_TIMEOUT_KEY, editing),
  });
  const globalInvalid = isInvalidTimeoutValue(globalHook.draft);
  const globalDisplay = readGlobalTimeoutDisplay(env);
  const [resettingGlobal, setResettingGlobal] = useState(false);

  const overrideCount = LLM_STEPS.filter((step) => {
    const state = env.get(step.timeoutEnvKey);
    return state?.source === 'override';
  }).length;

  const onGlobalReset = async () => {
    setResettingGlobal(true);
    try {
      const ok = await resetEnvKey(GLOBAL_TIMEOUT_KEY);
      if (ok) globalHook.clear();
      else globalHook.markError(tActions('reset_failed_inline'));
    } finally {
      setResettingGlobal(false);
    }
  };
  // Hide global Reset while a blur-save is in flight on the same key —
  // otherwise the slow-returning save can write back the just-reset value
  // (last-write-wins). Mirrors the per-step row's `hook.state !== 'saving'`
  // guard that was added on line 90 above.
  const showGlobalReset = globalState?.source === 'override' && globalHook.state !== 'saving';

  return (
    <div className="gp-llm-timeout-panel">
      <SettingsField
        tagLabels={fieldTagLabels}
        label={t('timeout_global_label')}
        hint={t('timeout_global_hint')}
        env={GLOBAL_TIMEOUT_KEY}
        source={globalState?.source}
        baselineDiffers={globalState?.baselineDiffers}
        shadowed={globalState?.source === 'override' && globalState?.baselineDiffers === true}
        onReset={showGlobalReset ? onGlobalReset : undefined}
        resetting={resettingGlobal}
        resetLabel={tMatrix('reset_label')}
        resetInProgressLabel={tMatrix('reset_in_progress_label')}
        resetTitle={tMatrix('reset_title')}
        value={
          <span className="gp-llm-timeout-global">
            <input
              type="number"
              className="gp-sinput gp-llm-timeout-global__input"
              aria-label={t('timeout_global_label')}
              placeholder={String(GLOBAL_LLM_TIMEOUT_DEFAULT_SECONDS)}
              value={globalHook.draft}
              min={MIN_TIMEOUT_SECONDS}
              max={MAX_TIMEOUT_SECONDS}
              step={1}
              inputMode="numeric"
              disabled={globalHook.state === 'saving'}
              onChange={(e) => globalHook.setDraft(e.target.value)}
              onBlur={() => {
                if (globalHook.dirty) void globalHook.save();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  globalHook.cancel();
                }
              }}
            />
            <span className="gp-llm-timeout-global__unit">{tMatrix('timeout_unit')}</span>
            {globalInvalid ? (
              <span className="gp-llm-step-row__warn">
                {tMatrix('timeout_invalid', {
                  min: String(MIN_TIMEOUT_SECONDS),
                  max: String(MAX_TIMEOUT_SECONDS),
                })}
              </span>
            ) : null}
          </span>
        }
      />

      <details className="gp-llm-timeout-advanced">
        <summary className="gp-llm-timeout-advanced__summary">
          <span>{t('timeout_advanced_heading')}</span>
          <span className="gp-llm-timeout-advanced__count">
            {overrideCount > 0
              ? t('timeout_advanced_count_some', { count: overrideCount })
              : t('timeout_advanced_count_none')}
          </span>
        </summary>
        <p className="gp-llm-timeout-advanced__hint">
          {t('timeout_advanced_hint', { default: globalDisplay })}
        </p>
        <div className="gp-llm-timeout-list">
          {LLM_STEPS.map((step) => (
            <StepTimeoutRow
              key={step.id}
              stepId={step.id}
              envKey={step.timeoutEnvKey}
              label={t(`steps.${step.id}.label`)}
              globalDisplay={globalDisplay}
              env={env}
              commit={commit}
              resetEnvKey={resetEnvKey}
              setFieldEditing={setFieldEditing}
            />
          ))}
        </div>
      </details>
    </div>
  );
}
