'use client';

import type {
  ManagedEnvKey,
  PluginActionDescriptor,
  PluginNoticeDescriptor,
  SettingsFieldDescriptor,
} from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Btn } from '@/components/ui/button';
import { SettingsField } from '@/components/ui/settings-field';
import { Toggle } from '@/components/ui/toggle';
import { useEditableCommit, useToggleCommit } from '@/components/ui/use-field-commit';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { SecretRow } from './secret-row';
import type { GroupProps } from './settings-shell';
import { useFieldTagLabels } from './use-field-tag-labels';

// Building blocks for callers that compose plugin contributions into their
// own layout. Each block now drives its own per-field auto-commit through
// the shared `useToggleCommit` / `useEditableCommit` hooks — the legacy
// dirty-store + SaveBar path is gone for these rows, matching the
// account.tsx pilot pattern.
//
// There is intentionally no `<PluginContributionCard>` wrapper here: search /
// notify / future groups each want different visual chrome (single shared
// card vs. one card per plugin, with or without setup-guide accordions), so
// the host group renders the chrome and uses these blocks for the field
// rows + action buttons inside.

/**
 * Mirror of the live-on computation inside `PluginEnableToggle`. Exported so
 * group renderers (search.tsx, etc.) can decide whether to fold the body
 * rows when the toggle is off. Reads ONLY from env (auto-commit means
 * every change has already landed) — `group.dirty` is intentionally
 * ignored here so the value reflects the latest committed state.
 */
export function readLiveEnabled(envKey: string, defaultValue: boolean, group: GroupProps): boolean {
  const state = group.env.get(envKey);
  const raw = state?.mask;
  const hasConfiguredValue = raw !== undefined && !(state?.configured === false && raw === '');
  return raw === 'true' || (!hasConfiguredValue && defaultValue);
}

// Shared reset coordination: on success clears the hook to drop any stale
// "Saved · restart" indicator; on failure surfaces an inline error so the
// FieldStatus row stops claiming success that the server didn't honour.
// Mirrors the account / embedding / collect pattern verbatim.
function useResetCoordination(
  envKey: string,
  group: GroupProps,
  hookState: string,
  hookClear: () => void,
  hookMarkError: (m: string) => void,
) {
  const tActions = useTranslations('settings.actions');
  const [resetting, setResetting] = useState(false);
  const state = group.env.get(envKey);
  const eligible = state?.source === 'override' && hookState !== 'saving';
  const onReset = eligible
    ? async () => {
        setResetting(true);
        try {
          const ok = await group.resetEnvKey(envKey);
          if (ok) {
            hookClear();
          } else {
            hookMarkError(tActions('reset_failed_inline'));
          }
        } finally {
          setResetting(false);
        }
      }
    : undefined;
  return {
    source: state?.source,
    baselineDiffers: state?.baselineDiffers,
    shadowed: state?.source === 'override' && state?.baselineDiffers === true,
    onReset,
    resetting,
    resetLabel: tActions('reset'),
    resetInProgressLabel: tActions('reset_in_progress'),
    resetTitle: tActions('reset_hint'),
  };
}

export function PluginFieldRow({
  field,
  group,
  labelOverride,
  extraHint,
  secretI18nNamespace = 'settings.search',
}: {
  field: SettingsFieldDescriptor;
  group: GroupProps;
  /** Override the field's own label — used by `search.tsx` so the first row
   *  shows the plugin branding name instead of the field name. */
  labelOverride?: string;
  extraHint?: ReactNode;
  secretI18nNamespace?: string;
}) {
  const label = labelOverride ?? field.label;
  const hint =
    field.hint !== undefined || extraHint !== undefined ? (
      <>
        {field.hint !== undefined ? <span>{field.hint}</span> : null}
        {extraHint}
      </>
    ) : undefined;

  if (field.kind === 'secret' || field.kind === 'text') {
    // Only surface schema default for plain `text` fields — `secret` kinds
    // typically don't declare a meaningful default (credentials), and we
    // don't want a hint that looks like a real value to confuse the user.
    const fieldDefault =
      field.kind === 'text' && typeof field.default === 'string' ? field.default : undefined;
    return (
      <SecretRow
        label={label}
        envKey={field.envKey as ManagedEnvKey}
        placeholder={field.placeholder ?? ''}
        hint={hint}
        group={group}
        i18nNamespace={secretI18nNamespace}
        {...(field.requiresRestart === true ? { restart: 'restart' as const } : {})}
        kind={field.kind === 'secret' ? 'secret' : 'plain'}
        defaultValue={fieldDefault}
      />
    );
  }

  if (field.kind === 'toggle') {
    return <ToggleFieldRow field={field} group={group} label={label} hint={hint} />;
  }

  if (field.kind === 'number') {
    return <NumberFieldRow field={field} group={group} label={label} hint={hint} />;
  }

  if (field.kind === 'segmented') {
    return <SegmentedFieldRow field={field} group={group} label={label} hint={hint} />;
  }

  return null;
}

/**
 * Plugin-level notices: warn / info callouts the plugin author declares on
 * its contribution. Renders above the enable toggle so caveats are visible
 * before the user opts in. `notice.kind` controls the color; `message` is
 * already locale-resolved by the server route.
 */
export function PluginNoticesBlock({
  notices,
}: {
  notices: ReadonlyArray<PluginNoticeDescriptor>;
}) {
  if (notices.length === 0) return null;
  return (
    <div className="gp-plugin-notices">
      {notices.map((notice, idx) => (
        <div
          // notices are a static, plugin-declared list with no reordering,
          // so positional key is stable. We include kind for clarity.
          // biome-ignore lint/suspicious/noArrayIndexKey: stable list, no reordering.
          key={`${notice.kind}-${idx}`}
          className={`gp-plugin-notice gp-plugin-notice--${notice.kind}`}
          role={notice.kind === 'warn' ? 'alert' : 'status'}
        >
          <span className="gp-plugin-notice__icon" aria-hidden="true">
            {notice.kind === 'warn' ? '!' : 'i'}
          </span>
          <span className="gp-plugin-notice__body">{notice.message}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Compact inline variant of `PluginEnableToggle` for `PluginMeta.trailing`.
 * Strips the SettingsField row chrome (label / hint / right column) so the
 * toggle sits next to the plugin branding on the same line. The reset
 * button stays inline so users can clear an override without expanding the
 * plugin body. Use `PluginEnableToggle` when you want the full row layout
 * with hint slot.
 */
export function PluginEnableInline({
  envKey,
  label,
  defaultValue = false,
  group,
  onLiveChange,
}: {
  envKey: string;
  label: string;
  defaultValue?: boolean;
  group: GroupProps;
  /** Notify parent of the OPTIMISTIC live state on every change (click +
   * sibling env refresh). Parents wire this to a useState mirror so
   * sibling readers (e.g. an `expanded ? ... : null` body) see the same
   * optimistic flip as the toggle itself — without this they read
   * `readLiveEnabled` straight from env, which lags by the commit
   * roundtrip and the body/actions stay visible after the toggle has
   * visually moved OFF. */
  onLiveChange?: (live: boolean) => void;
}) {
  const t = useTranslations('settings.search');
  const tActions = useTranslations('settings.actions');
  const state = group.env.get(envKey);
  // committed seeds from env mask; default value applies when the mask is
  // missing/empty (matches readLiveEnabled's unconfigured-default behaviour).
  const seedCommitted =
    state?.mask === 'true' || state?.mask === 'false' ? state.mask : String(defaultValue);
  const hook = useToggleCommit({
    envKey,
    committed: seedCommitted,
    commit: group.commit,
    fieldName: label,
    baselineDiffers: state?.baselineDiffers,
  });
  const live = hook.current === 'true';
  // Mirror optimistic `live` upward so search.tsx (and any future
  // caller) can decide expand/collapse on the same value the toggle
  // shows, not the lagging env mask.
  const onLiveChangeRef = useRef(onLiveChange);
  onLiveChangeRef.current = onLiveChange;
  useEffect(() => {
    onLiveChangeRef.current?.(live);
  }, [live]);
  const [resetting, setResetting] = useState(false);
  const showReset = state?.source === 'override' && hook.state !== 'saving';
  return (
    <div className="gp-plugin-enable-inline">
      <span className="gp-plugin-enable-inline__status">
        {live ? t('on_label') : t('off_label')}
      </span>
      <Toggle
        ariaLabel={label}
        on={live}
        disabled={hook.state === 'saving'}
        onChange={(v) => {
          void hook.fire(v ? 'true' : 'false');
        }}
      />
      {showReset && (
        <button
          type="button"
          className="gp-plugin-enable-inline__reset"
          disabled={resetting}
          title={tActions('reset_hint')}
          onClick={async () => {
            setResetting(true);
            try {
              const ok = await group.resetEnvKey(envKey);
              if (ok) {
                hook.clear();
              } else {
                hook.markError(tActions('reset_failed_inline'));
              }
            } finally {
              setResetting(false);
            }
          }}
        >
          {resetting ? tActions('reset_in_progress') : tActions('reset')}
        </button>
      )}
    </div>
  );
}

export function PluginEnableToggle({
  envKey,
  label,
  defaultValue = false,
  hint,
  group,
}: {
  envKey: string;
  label: string;
  defaultValue?: boolean;
  hint?: ReactNode;
  group: GroupProps;
}) {
  const t = useTranslations('settings.search');
  const fieldTagLabels = useFieldTagLabels();
  const state = group.env.get(envKey);
  const seedCommitted =
    state?.mask === 'true' || state?.mask === 'false' ? state.mask : String(defaultValue);
  const hook = useToggleCommit({
    envKey,
    committed: seedCommitted,
    commit: group.commit,
    fieldName: label,
    baselineDiffers: state?.baselineDiffers,
  });
  const resetProps = useResetCoordination(envKey, group, hook.state, hook.clear, hook.markError);
  const live = hook.current === 'true';
  return (
    <SettingsField
      tagLabels={fieldTagLabels}
      label={label}
      hint={hint}
      env={envKey}
      {...resetProps}
      status={hook.status}
      value={live ? t('on_label') : t('off_label')}
      control={
        <Toggle
          ariaLabel={label}
          on={live}
          disabled={hook.state === 'saving'}
          onChange={(v) => {
            void hook.fire(v ? 'true' : 'false');
          }}
        />
      }
    />
  );
}

function ToggleFieldRow({
  field,
  group,
  label,
  hint,
}: {
  field: SettingsFieldDescriptor;
  group: GroupProps;
  label: string;
  hint?: ReactNode;
}) {
  const t = useTranslations('settings.search');
  const fieldTagLabels = useFieldTagLabels();
  const state = group.env.get(field.envKey);
  const seedCommitted =
    state?.mask === 'true' || state?.mask === 'false'
      ? state.mask
      : field.default === true
        ? 'true'
        : 'false';
  const hook = useToggleCommit({
    envKey: field.envKey,
    committed: seedCommitted,
    commit: group.commit,
    fieldName: label,
    baselineDiffers: state?.baselineDiffers,
  });
  const resetProps = useResetCoordination(
    field.envKey,
    group,
    hook.state,
    hook.clear,
    hook.markError,
  );
  const live = hook.current === 'true';
  return (
    <SettingsField
      tagLabels={fieldTagLabels}
      label={label}
      hint={hint}
      env={field.envKey}
      {...(field.requiresRestart === true ? { restart: 'restart' as const } : {})}
      {...resetProps}
      status={hook.status}
      value={live ? t('on_label') : t('off_label')}
      control={
        <Toggle
          ariaLabel={label}
          on={live}
          disabled={hook.state === 'saving'}
          onChange={(v) => {
            void hook.fire(v ? 'true' : 'false');
          }}
        />
      }
    />
  );
}

function NumberFieldRow({
  field,
  group,
  label,
  hint,
}: {
  field: SettingsFieldDescriptor;
  group: GroupProps;
  label: string;
  hint?: ReactNode;
}) {
  const fieldTagLabels = useFieldTagLabels();
  const state = group.env.get(field.envKey);
  // Server returns `mask: ''` for unconfigured (source='default') keys.
  // Plain `?? ''` would seed the editable hook with empty, so the input
  // and right-side value both read "—" while the runtime is actually
  // using the schema default — silent display/runtime drift.
  //
  // We deliberately DON'T use `state?.mask || defaultStr`: number fields
  // can legitimately store '0', which is truthy as a string but the `||`
  // operator's checking is identity-level (any falsy → fallback). For
  // numbers specifically the safe operator would be `?? ''` … but `''`
  // is itself a valid string we want to fall back from. So neither
  // short-circuit suffices — explicit empty check.
  //
  // Toggle / enum / segmented use `||` safely because their value strings
  // ('true' / 'false' / 'auto' / etc.) are always non-empty truthy. Only
  // number is exposed to the '0' edge case.
  const defaultStr = field.default !== undefined ? String(field.default) : '';
  const seedMask = state?.mask !== undefined && state.mask !== '' ? state.mask : defaultStr;
  const hook = useEditableCommit({
    envKey: field.envKey,
    committed: seedMask,
    commit: group.commit,
    fieldName: label,
    baselineDiffers: state?.baselineDiffers,
    onEditingChange: (editing) => group.setFieldEditing(field.envKey, editing),
  });
  const resetProps = useResetCoordination(
    field.envKey,
    group,
    hook.state,
    hook.clear,
    hook.markError,
  );
  // Right-side value: when the user has emptied the input, show the
  // plugin default if known, otherwise the generic "—". Without the
  // default fallback, an emptied field reads "—" while the server is
  // still using the schema default — same drift the seed fixes above.
  const valueDisplay = hook.draft === '' ? (defaultStr !== '' ? defaultStr : '—') : hook.draft;
  return (
    <SettingsField
      tagLabels={fieldTagLabels}
      label={label}
      hint={hint}
      env={field.envKey}
      {...(field.requiresRestart === true ? { restart: 'restart' as const } : {})}
      {...resetProps}
      status={hook.status}
      value={valueDisplay}
      control={
        <input
          type="number"
          className="gp-sinput gp-sinput--num"
          placeholder={field.placeholder ?? ''}
          value={hook.draft}
          min={field.min}
          max={field.max}
          step={field.step}
          aria-label={label}
          disabled={hook.state === 'saving'}
          onChange={(e) => hook.setDraft(e.target.value)}
          onBlur={() => {
            if (hook.dirty) void hook.save();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // No blur — see collect.tsx FieldNumber for race rationale.
              hook.cancel();
            }
          }}
        />
      }
    />
  );
}

function SegmentedFieldRow({
  field,
  group,
  label,
  hint,
}: {
  field: SettingsFieldDescriptor;
  group: GroupProps;
  label: string;
  hint?: ReactNode;
}) {
  const fieldTagLabels = useFieldTagLabels();
  const state = group.env.get(field.envKey);
  const seed = state?.mask ?? (field.default as string | undefined) ?? '';
  const hook = useToggleCommit({
    envKey: field.envKey,
    committed: seed,
    commit: group.commit,
    fieldName: label,
    baselineDiffers: state?.baselineDiffers,
  });
  const resetProps = useResetCoordination(
    field.envKey,
    group,
    hook.state,
    hook.clear,
    hook.markError,
  );
  return (
    <SettingsField
      tagLabels={fieldTagLabels}
      label={label}
      hint={hint}
      env={field.envKey}
      {...(field.requiresRestart === true ? { restart: 'restart' as const } : {})}
      {...resetProps}
      status={hook.status}
      value={field.options?.find((o) => o.value === hook.current)?.label ?? hook.current}
      control={
        <select
          className="gp-sinput"
          value={hook.current}
          aria-label={label}
          disabled={hook.state === 'saving'}
          onChange={(e) => {
            void hook.fire(e.target.value);
          }}
        >
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      }
    />
  );
}

/**
 * Test-connection / probe / lookup button row. `requires` checks the named
 * fields are filled before enabling the click — auto-commit means typed
 * values land on the server before the action fires, so the check reads
 * only from env (no separate dirty draft to consult). Matches the IM
 * `<ImChannelCard>` action semantics.
 */
export function PluginActionButton({
  pluginId,
  action,
  fields,
  group,
}: {
  pluginId: string;
  action: PluginActionDescriptor;
  fields: ReadonlyArray<SettingsFieldDescriptor>;
  group: GroupProps;
}) {
  const [pending, setPending] = useState(false);
  const fieldTagLabels = useFieldTagLabels();
  const tContribution = useTranslations('settings.contribution');
  // Host-defined error codes the contribution route may return regardless of
  // whether the plugin author declared an i18n string for them. Mapping them
  // here keeps zh users from seeing raw English zod messages (e.g. "Invalid
  // input: expected number, received NaN") or bare code identifiers when the
  // host short-circuits before the plugin handler runs.
  const HOST_FALLBACK_KEYS: Record<string, string> = {
    validation: tContribution('validation_error_toast'),
    timeout: tContribution('timeout_error_toast'),
    internal: tContribution('internal_error_toast'),
  };
  const requiredMissing = (action.requires ?? []).some((fieldName) => {
    const field = fields.find((f) => f.name === fieldName);
    if (field === undefined) return false; // unknown name → don't block
    // Auto-commit eliminates the "typed but unsaved" interim state — every
    // committed change lands on the server immediately, so reading
    // `configured` from env reflects the truth the action handler will see.
    return group.env.get(field.envKey)?.configured !== true;
  });
  // Block the action while any required field still has an in-flight commit.
  // The action handler reads `process.env` directly on the server; running
  // before the commit has landed would test the OLD value. The shell tracks
  // inFlightKeys per-key (Map-based counting since multiple concurrent
  // commits to the same key are possible), and we wait until every required
  // field's count returns to zero.
  const requiredInFlight = (action.requires ?? []).some((fieldName) => {
    const field = fields.find((f) => f.name === fieldName);
    if (field === undefined) return false;
    return group.inFlightKeys.has(field.envKey);
  });

  return (
    <SettingsField
      tagLabels={fieldTagLabels}
      label={action.label}
      control={
        <Btn
          sm
          disabled={pending || requiredMissing || requiredInFlight}
          onClick={async () => {
            setPending(true);
            try {
              const client = getBrowserApiClient();
              // No dirty values to forward — auto-commit means everything
              // typed has already been persisted. The action handler reads
              // env directly on the server side.
              const result = await client.invokeContributionAction(pluginId, action.id, {});
              if (result.ok) {
                group.toast({ kind: 'success', msg: action.label });
              } else {
                // Plugin-declared message wins (the plugin author chose the
                // wording). Otherwise fall back to a host-side i18n string for
                // codes the host originates (validation / timeout / internal),
                // and only then to raw `result.message` / `result.code` —
                // raw zod messages are English and break zh users' experience.
                const localized =
                  action.errorMessages?.[result.code] ?? HOST_FALLBACK_KEYS[result.code];
                group.toast({
                  kind: 'danger',
                  msg: localized ?? result.message ?? result.code,
                });
              }
            } catch (err) {
              group.toast({
                kind: 'danger',
                msg: err instanceof Error ? err.message : 'unknown error',
              });
            } finally {
              setPending(false);
            }
          }}
        >
          {action.label}
        </Btn>
      }
    />
  );
}
