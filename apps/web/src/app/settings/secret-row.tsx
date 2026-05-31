'use client';

import type { ManagedEnvKey } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { Btn } from '@/components/ui/button';
import { SettingsField } from '@/components/ui/settings-field';
import { useEditableCommit } from '@/components/ui/use-field-commit';
import type { GroupProps } from './settings-shell';
import { useFieldTagLabels } from './use-field-tag-labels';

interface Props {
  label: string;
  envKey: ManagedEnvKey;
  placeholder: string;
  group: GroupProps;
  restart?: 'restart';
  /**
   * Namespace holding the 8 secret-edit keys:
   * `value_pending / value_unconfigured / fill_button / refill_button /
   * cancel_button / confirm_button / reveal_button / hide_button`.
   * Each consumer group (settings.llm / settings.search / settings.notify)
   * owns its own copy so wording can diverge if needed.
   */
  i18nNamespace: string;
  /**
   * 行下方一行小灰字 —— 用来给"这个 engine 适合什么场景 / 成本"等定位描述。
   * 透传给 SettingsField.hint。
   */
  hint?: ReactNode;
  /**
   * `'secret'`（默认）— input 走 password type、提供 reveal/hide 切换；server
   * 端会用 `••••<last4>` mask 已配置值。
   * `'plain'` — input 走 text type、不显示 reveal/hide；用于 URL / 主机名等
   * 非 secret 的 env key（如 SearXNG base URL）。server 端对非 secret key
   * 直接返回完整 mask 字符串，因此显示也是明文。
   */
  kind?: 'secret' | 'plain';
  /**
   * Schema default to surface when the env key is unconfigured. Plugin
   * contributions (e.g. digest's `dailyTime: '06:00'`) pass this so the row
   * displays the actual runtime value instead of "未配置" — without it the
   * UI lies about what the server is using. Secret kinds typically leave
   * this unset (no meaningful default exists for a credential) and the
   * fallback to `t('value_unconfigured')` still applies.
   */
  defaultValue?: string;
}

// SecretRow renders a single env-backed secret with the canonical edit flow:
// mask + 重新填写/填写 → input (password / text toggle) → cancel / confirm.
// Confirm fires a per-field auto-commit through `useEditableCommit` (drives
// inline FieldStatus saving/saved/error), bypassing the legacy dirty store +
// SaveBar path. Shared by llm / search / collect / notify groups.
export function SecretRow({
  label,
  envKey,
  placeholder,
  group,
  i18nNamespace,
  restart,
  hint,
  kind = 'secret',
  defaultValue,
}: Props) {
  const t = useTranslations(i18nNamespace);
  const tActions = useTranslations('settings.actions');
  const fieldTagLabels = useFieldTagLabels();
  const [editing, setEditing] = useState(false);
  const [reveal, setReveal] = useState(false);
  const isPlain = kind === 'plain';
  const [resetting, setResetting] = useState(false);

  const state = group.env.get(envKey);
  const configured = state?.configured === true;

  // `committed` stays empty — the server returns a `••••last4` mask
  // intentionally; binding it to `useEditableCommit.committed` would let
  // browser autofill / a stray click write the mask back to the server as
  // the real secret (the exact footgun the masked-display contract is
  // designed to prevent). Caller drives the typed value through `draft`
  // and only sends it via save(overrideValue) — never as a controlled
  // input bound to the masked display.
  //
  // Side-effect: useEditableCommit's `committed`-change useEffect (which
  // resyncs draft when the upstream env mask shifts) is effectively dead
  // here, since `committed` is the literal `''` on every render. That's
  // intentional, not a bug — the draft lifecycle is driven manually by
  // the `editing` toggle (`hook.setDraft('')` on entry, `cancel()` /
  // `save()` on exit). Future maintainers: if you ever wire `committed`
  // to anything dynamic in this row, audit the mask-write footgun above.
  const hook = useEditableCommit({
    envKey,
    committed: '',
    commit: group.commit,
    fieldName: label,
    baselineDiffers: state?.baselineDiffers,
  });

  // Tell the shell this row has an in-edit draft so its leave-guard
  // prompts on group switch / tab close while a typed secret hasn't
  // been committed yet. Cleared on cancel / successful save (handled
  // via setEditing(false) + the cleanup below) and on unmount.
  useEffect(() => {
    const hasDraft = editing && hook.draft.length > 0;
    group.setFieldEditing(envKey, hasDraft);
    return () => group.setFieldEditing(envKey, false);
  }, [editing, hook.draft, envKey, group.setFieldEditing]);

  const valueDisplay = editing
    ? null
    : configured
      ? (state?.mask ?? '••••')
      : // Prefer the plugin-declared default over the generic "未配置"
        // copy: digest's dailyTime row reads "06:00" instead of "未配置"
        // when the env is on schema default, matching the actual runtime
        // value. Falls back to the i18n unconfigured copy when no
        // default was declared (secrets / fields without a sensible
        // default).
        (defaultValue ?? t('value_unconfigured'));

  const exitEdit = (preserveStatus = false) => {
    setEditing(false);
    setReveal(false);
    if (!preserveStatus) {
      hook.cancel();
    }
  };

  return (
    <SettingsField
      tagLabels={fieldTagLabels}
      label={label}
      hint={hint}
      env={envKey}
      restart={restart}
      source={state?.source}
      baselineDiffers={state?.baselineDiffers}
      onReset={
        // Hide the reset button while editing — reverting mid-draft would
        // wipe the user's typed-but-not-yet-confirmed value. Also hide
        // while save() is in flight so the user can't race two writes.
        state?.source === 'override' && !editing && hook.state !== 'saving'
          ? async () => {
              setResetting(true);
              try {
                const ok = await group.resetEnvKey(envKey);
                if (ok) {
                  hook.clear();
                } else {
                  // Same rationale as account.tsx — toast fades, FieldStatus
                  // must reflect that the override is still live so the
                  // row doesn't keep claiming "Saved · restart".
                  hook.markError(tActions('reset_failed_inline'));
                }
              } finally {
                setResetting(false);
              }
            }
          : undefined
      }
      resetting={resetting}
      resetLabel={tActions('reset')}
      resetInProgressLabel={tActions('reset_in_progress')}
      resetTitle={tActions('reset_hint')}
      shadowed={state?.source === 'override' && state?.baselineDiffers === true}
      status={hook.status}
      valueInk={configured && !editing}
      value={
        editing ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: rendered only on edit entry
            autoFocus
            type={isPlain || reveal ? 'text' : 'password'}
            className="gp-sinput gp-sinput--mono"
            placeholder={placeholder}
            value={hook.draft}
            disabled={hook.state === 'saving'}
            onChange={(e) => hook.setDraft(e.target.value)}
          />
        ) : (
          valueDisplay
        )
      }
      control={
        editing ? (
          <>
            {isPlain ? null : (
              <Btn sm onClick={() => setReveal((r) => !r)} disabled={hook.state === 'saving'}>
                {reveal ? t('hide_button') : t('reveal_button')}
              </Btn>
            )}
            <Btn sm onClick={() => exitEdit()} disabled={hook.state === 'saving'}>
              {t('cancel_button')}
            </Btn>
            <Btn
              sm
              kind="primary"
              disabled={hook.draft.length === 0 || hook.state === 'saving'}
              onClick={async () => {
                const outcome = await hook.save(hook.draft);
                switch (outcome.kind) {
                  case 'saved':
                  case 'pending-restart':
                  case 'no-op':
                    // Clear the typed secret from React state before exiting
                    // edit. exitEdit(true) skips hook.cancel() (which would
                    // also do this) to preserve the freshly-set 'saved' /
                    // 'pending-restart' status indicator from a stale-closure
                    // re-pristinage — but cancel was also our path to wiping
                    // the plaintext draft. Wipe explicitly here so the secret
                    // doesn't linger in memory / React DevTools after submit.
                    hook.setDraft('');
                    exitEdit(true);
                    break;
                  case 'error':
                  case 'superseded':
                    // Keep edit form open so the user can retry / wait for
                    // the in-flight attempt.
                    break;
                }
              }}
            >
              {t('confirm_button')}
            </Btn>
          </>
        ) : (
          <Btn
            sm
            onClick={() => {
              setEditing(true);
              // Pre-fill the input with the plugin-declared default (when
              // available) so the user sees what's actually running and
              // can tweak it instead of typing the whole value from
              // scratch. defaultValue is only ever set for `kind: 'text'`
              // contribution fields (plugin-contribution-card.tsx
              // explicitly skips it for secrets); the existing 'secret'
              // and 'unconfigured-with-no-default' paths still enter
              // editing with an empty draft, preserving the mask-as-
              // token footgun protection documented up top.
              hook.setDraft(configured ? '' : (defaultValue ?? ''));
            }}
          >
            {configured ? t('refill_button') : t('fill_button')}
          </Btn>
        )
      }
    />
  );
}
