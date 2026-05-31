'use client';

import type {
  ImActionResult,
  ImSettingsActionDescriptor,
  ImSettingsField,
  ImSettingsManifest,
  LocalizedString,
} from '@goldpan/web-sdk';
import { useEffect, useRef, useState } from 'react';
import { Btn } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { SettingsCard } from '@/components/ui/settings-card';
import { type FieldTagLabels, SettingsField } from '@/components/ui/settings-field';
import { Toggle } from '@/components/ui/toggle';
import { rethrowNextErrors } from '@/lib/rethrow';
import { SetupGuide } from './setup-guide';

export interface ImChannelCardProps {
  manifest: ImSettingsManifest;
  mode: 'settings' | 'wizard';
  language: 'en' | 'zh';
  /** Current values keyed by manifest field.name + special `__enabled` key. */
  values: { __enabled?: boolean } & Record<string, string | boolean | undefined>;
  /** Called for any value change. fieldName='__enabled' for the channel toggle.
   *  Wizard mode uses this to sync into wizard state on every keystroke /
   *  click. Settings mode passes a no-op or omits real work here — it
   *  relies on `onCommit` instead. */
  onChange: (fieldName: string, value: string | boolean) => void;
  /**
   * Optional commit callback for settings mode auto-commit.
   *
   * When provided:
   *   - enable / toggle / segmented click → `onCommit` fires immediately
   *     (skips `onChange`'s code path for the commit itself).
   *   - text / secret input → keystrokes update a per-field local draft
   *     so the user can SEE what they type (host's `values[name]` stays
   *     empty for masked secrets / pre-commit env), then `onCommit` fires
   *     once on blur.
   *
   * Return value contract: settings hosts SHOULD return a Promise<boolean>
   * resolving to `true` when the commit landed successfully and `false`
   * (or never resolve) on failure. TextSecretField uses this to decide
   * whether to clear localDraft (`true` → clear so the masked placeholder
   * takes over) or retain it (`false` → keep the typed value visible for
   * retry). Returning `undefined` is still allowed for backwards-compat /
   * fire-and-forget toggle paths; in that case localDraft is cleared on
   * unmount only (next user edit overwrites).
   *
   * Wizard mode omits this prop; every change flows through `onChange`
   * for real-time wizard-state sync (the wizard host commits at the end).
   */
  onCommit?: (fieldName: string, value: string | boolean) => Promise<boolean> | boolean | undefined;
  /**
   * Per-field editing notification for settings mode. Called when a
   * text/secret input's local draft transitions in or out of the
   * "user is editing" state (non-null draft = editing). Settings hosts
   * wire this to `group.setFieldEditing(envKey, editing)` so the shell's
   * leave-guard prompts on tab close / group switch while uncommitted
   * typing is in the input — without this notification, IM token /
   * chat_id drafts silently disappeared when the user navigated away
   * (the rest of settings calls setFieldEditing from SecretRow / hooks).
   */
  onEditingChange?: (fieldName: string, editing: boolean) => void;
  /**
   * Triggered when user clicks an action button. Returns the server result.
   * Optional — when `disableActions` is true (wizard mode), this is never called
   * and may be omitted.
   */
  onAction?: (actionId: string) => Promise<ImActionResult>;
  /** Field-level metadata for settings mode (mask/configured/dirty per envKey). */
  envMeta?: (envKey: string) => {
    configured: boolean;
    mask?: string;
    dirty: boolean;
    source?: 'env' | 'override' | 'default';
  };
  /** Toast hook from the host page. */
  toast: (msg: { kind: 'success' | 'danger'; msg: string }) => void;
  /**
   * When true, hide all action buttons entirely. Used by wizard mode where the
   * .env doesn't yet have the values — running `test` would test empty config
   * and confuse users. Better UX is to omit the buttons than render disabled
   * placeholder buttons that do nothing.
   */
  disableActions?: boolean;
  /**
   * tag chips passed through verbatim to nested SettingsField (restart / readonly /
   * env / todo / shadowed). Hosts can resolve via `useFieldTagLabels()`.
   */
  tagLabels: FieldTagLabels;
}

const t = (s: LocalizedString, lang: 'en' | 'zh'): string => s[lang];

export function ImChannelCard(props: ImChannelCardProps) {
  const {
    manifest,
    mode,
    language,
    values,
    onChange,
    onCommit,
    onEditingChange,
    onAction,
    envMeta,
    toast,
    disableActions,
    tagLabels,
  } = props;
  const enabled = values.__enabled ?? manifest.enable.default;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // Routing helper: `onCommit` (settings) takes precedence over `onChange`
  // (wizard) for instant-decision controls (enable toggle / field toggle /
  // segmented). Text/secret fields use a different routing in FieldRenderer
  // — they bind onChange for the local-draft sync and onCommit for blur.
  const fireInstant = (name: string, v: string | boolean) =>
    onCommit ? onCommit(name, v) : onChange(name, v);

  // 关闭状态下折叠 setup guide / fields / actions，只留 header + toggle，
  // 让 onboarding / settings 页不被未启用渠道的空表单干扰。要编辑凭据
  // 或 test config 的用户必须先 toggle 打开 —— 多一步操作换"列表更干净"，
  // 在用户还没打开任何渠道的常见场景下值。
  //
  // 不往 SettingsCard 传任何 children：与 onboarding 语言/主题行一致，使用
  // `.gp-scard__head--solo`（无 head 底部分隔线）。若传了子节点即使内容为
  // empty，SettingsCard 仍会认为有 body，head 会保留 border-bottom，出现横向细线。
  if (!enabled) {
    return (
      <SettingsCard
        heading={t(manifest.branding.name, language)}
        right={<Toggle on={enabled} onChange={(v) => fireInstant('__enabled', v)} />}
      />
    );
  }

  return (
    <SettingsCard
      heading={t(manifest.branding.name, language)}
      right={<Toggle on={enabled} onChange={(v) => fireInstant('__enabled', v)} />}
    >
      <SetupGuide manifest={manifest} language={language} />
      {manifest.fields.map((field) => (
        <FieldRenderer
          key={field.name}
          field={field}
          mode={mode}
          language={language}
          value={values[field.name]}
          envMeta={envMeta}
          onChange={(v) => onChange(field.name, v)}
          onCommit={onCommit !== undefined ? (v) => onCommit(field.name, v) : undefined}
          onEditingChange={
            onEditingChange !== undefined ? (e) => onEditingChange(field.name, e) : undefined
          }
          tagLabels={tagLabels}
        />
      ))}
      {!disableActions &&
        manifest.actions.map((action) => {
          const requirementsMet = action.requires.every((name) => {
            const v = values[name];
            if (typeof v === 'string' && v.length > 0) return true;
            if (typeof v === 'boolean') return v;
            // settings 模式：secret 字段没在 input 里（已脱敏，input 留空），但
            // env 已配置也算 "requirement met"。否则用户每次 test 前都要重输 token。
            if (mode === 'settings' && envMeta) {
              const f = manifest.fields.find((fld) => fld.name === name);
              if (f && envMeta(f.envKey).configured) return true;
            }
            return false;
          });
          const dirty = action.requires.some((name) => {
            const f = manifest.fields.find((fld) => fld.name === name);
            return f && envMeta?.(f.envKey).dirty === true;
          });
          const disabled =
            busyAction === action.id || !requirementsMet || (mode === 'settings' && dirty);
          return (
            <SettingsField
              key={action.id}
              tagLabels={tagLabels}
              label={t(action.label, language)}
              control={
                <Btn
                  sm
                  disabled={disabled}
                  onClick={async () => {
                    if (!onAction) return;
                    setBusyAction(action.id);
                    try {
                      const res = await onAction(action.id);
                      if (res.ok) {
                        toast({ kind: 'success', msg: `${t(action.label, language)} ✓` });
                      } else {
                        toast({ kind: 'danger', msg: errorMessage(action, res, language) });
                      }
                    } finally {
                      setBusyAction(null);
                    }
                  }}
                >
                  {busyAction === action.id ? '…' : t(action.label, language)}
                </Btn>
              }
            />
          );
        })}
    </SettingsCard>
  );
}

function errorMessage(
  action: ImSettingsActionDescriptor,
  res: ImActionResult,
  language: 'en' | 'zh',
): string {
  // Fallback chain (spec §5.1):
  // 1. action.errorMessages[code]
  // 2. response.message (raw, may carry actionable info like Feishu larkMsg)
  // 3. host generic
  if (!res.ok) {
    const localized = res.code ? action.errorMessages?.[res.code] : undefined;
    if (localized) return localized[language];
    if (res.message && res.message.length > 0) return res.message;
  }
  return language === 'zh' ? '操作失败' : 'Action failed';
}

function FieldRenderer(props: {
  field: ImSettingsField;
  mode: 'settings' | 'wizard';
  language: 'en' | 'zh';
  value: string | boolean | undefined;
  envMeta?: ImChannelCardProps['envMeta'];
  onChange: (v: string | boolean) => void;
  /** Settings-mode auto-commit hook (see ImChannelCardProps.onCommit). */
  onCommit?: (v: string | boolean) => Promise<boolean> | boolean | undefined;
  /** Per-field editing notification (see ImChannelCardProps.onEditingChange). */
  onEditingChange?: (editing: boolean) => void;
  tagLabels: FieldTagLabels;
}) {
  // Destructure only fields FieldRenderer reads directly. `mode` and
  // `envMeta` are forwarded via `{...props}` to TextSecretField below;
  // pulling them out here would just trigger lint/noUnusedVariables.
  const { field, language, value, onChange, onCommit, tagLabels } = props;
  const label = t(field.label, language);
  const hint = field.hint ? t(field.hint, language) : undefined;
  // Routing helper for instant-decision controls (toggle/segmented). When
  // onCommit is wired (settings mode) we skip onChange — every click is a
  // final commit, no draft. Wizard falls back to onChange.
  const fireInstant = onCommit ?? onChange;

  if (field.kind === 'toggle') {
    return (
      <SettingsField
        tagLabels={tagLabels}
        label={label}
        hint={hint}
        control={<Toggle on={!!value} onChange={fireInstant} />}
      />
    );
  }

  if (field.kind === 'segmented') {
    // 把 ""(notify.tsx 把缺失字段初始化为空字符串)也视为未设置，回退 field.default。
    // 否则 fresh 安装下 segmented (例如 Feishu domain) 会出现"无任何选中项"。
    const segValue =
      typeof value === 'string' && value.length > 0
        ? value
        : ((field.default as string | undefined) ?? '');
    return (
      <SettingsField
        tagLabels={tagLabels}
        label={label}
        hint={hint}
        control={
          <Segmented
            value={segValue}
            options={(field.options ?? []).map((o) => ({
              value: o.value,
              label: t(o.label, language),
            }))}
            onChange={fireInstant}
          />
        }
      />
    );
  }

  return <TextSecretField {...props} />;
}

/**
 * Text/secret field renderer. Split out so it can hold a local draft state
 * — the host's `values[name]` is empty for secrets (avoiding the mask-as-
 * token footgun) and reflects committed env for plain text, neither of
 * which updates while the user is typing. The draft state lets the input
 * visibly track keystrokes; on blur, settings mode fires `onCommit` once
 * (replaces the prior per-keystroke commit flood). Wizard mode flushes
 * keystrokes through `onChange` as before for real-time wizard-state sync.
 *
 * Secret-masked display contract preserved:
 *   - configured + user not currently editing (localDraft === null): show
 *     empty input with mask as placeholder.
 *   - localDraft !== null: show the user's typed value (mask hidden) so
 *     the user can see what they've entered before blur.
 *   - text field / unconfigured / wizard mode: bind the value through as
 *     before, no draft layer needed (wizard's onChange already syncs
 *     state on every keystroke).
 *
 * The mask-as-token security contract (don't bind the masked string into
 * the input) still holds: `meta.mask` only goes into `placeholder`,
 * never into the controlled value.
 */
function TextSecretField(props: {
  field: ImSettingsField;
  mode: 'settings' | 'wizard';
  language: 'en' | 'zh';
  value: string | boolean | undefined;
  envMeta?: ImChannelCardProps['envMeta'];
  onChange: (v: string | boolean) => void;
  onCommit?: (v: string | boolean) => Promise<boolean> | boolean | undefined;
  onEditingChange?: (editing: boolean) => void;
  tagLabels: FieldTagLabels;
}) {
  const { field, mode, language, value, envMeta, onChange, onCommit, onEditingChange, tagLabels } =
    props;
  const label = t(field.label, language);
  const hint = field.hint ? t(field.hint, language) : undefined;
  const stringValue = typeof value === 'string' ? value : '';
  const isSecret = field.kind === 'secret';
  const meta = envMeta?.(field.envKey);

  // `null` means "user is not editing locally" — input falls back to the
  // host's `value` (or masked placeholder). Any keystroke flips it to a
  // string draft; the draft persists until the committed value lands
  // (host's onCommit promise resolves to true) or the component unmounts.
  const [localDraft, setLocalDraft] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const usingDraft = localDraft !== null;
  // Mirror localDraft into a ref so flushDraft's Promise.then closure can
  // read the LATEST value at resolve time — not the value captured at
  // fire time. Without this, a user who keeps typing after Enter (e.g.
  // types 'abc' Enter, then types 'd' before the commit resolves) has
  // their 'abcd' silently erased when the .then((ok) => setLocalDraft(null))
  // runs — the resolver doesn't know the draft moved on. Updated on
  // every render to stay in sync with setLocalDraft.
  const localDraftRef = useRef<string | null>(localDraft);
  localDraftRef.current = localDraft;

  // secret-masked-display gates on "not currently editing locally" so the
  // moment the user starts typing the placeholder mask is replaced by the
  // visible draft.
  const secretMaskedDisplay = isSecret && mode === 'settings' && meta?.configured && !usingDraft;
  const inputValue = secretMaskedDisplay ? '' : usingDraft ? localDraft : stringValue;
  const placeholder = secretMaskedDisplay
    ? meta?.mask
    : field.placeholder
      ? t(field.placeholder, language)
      : undefined;

  // Mirror onEditingChange via a ref so the dep array can stay
  // [localDraft]-only — the prop identity churns every render (notify.tsx
  // and the ImChannelCard parent both pass inline arrows), and having
  // it as a dep would re-fire the effect on every render. Combined with
  // setEditingFields's previous "always-allocate" filter (now fixed,
  // see settings-shell.tsx setFieldEditing), that path could explode
  // into "Maximum update depth exceeded" in production. The ref pattern
  // is the belt for the suspenders fix.
  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;
  useEffect(() => {
    onEditingChangeRef.current?.(localDraft !== null);
    // Unmount cleanup: emit editing=false so the shell's editingFields
    // releases its stale entry. Without this, a user mid-typing who
    // closes the channel toggle (collapses the card, unmounting this
    // field) would leave the shell convinced editing was still active —
    // every subsequent group switch prompts a phantom leave-guard until
    // full reload.
    return () => onEditingChangeRef.current?.(false);
  }, [localDraft]);

  // Note: we intentionally do NOT clear localDraft when `meta.mask` changes.
  // The Promise<boolean> path below is the sole signal for "commit landed,
  // safe to clear". Tying the clear to mask churn would erase a user's
  // in-progress typing when an EXTERNAL change updates env (another tab,
  // a sibling commit, web-sdk refetch) — those cause mask to flip without
  // any commit having been fired from this input. Hosts that don't return
  // Promise<boolean> from onCommit (none in-tree today; wizard mode omits
  // onCommit entirely and short-circuits flushDraft) would leave draft
  // lingering, but the unmount cleanup (onEditingChangeRef return) + next
  // user edit overwriting still bound the lifetime.

  // R7 dedupe: Enter and the subsequent blur both call flushDraft.
  // Without dedupe the same value commits twice. lastFlushedRef holds
  // the last value passed to onCommit; flushDraft bails when localDraft
  // already matches. Reset on every onChange so the next edit can fire
  // even with an identical value (e.g. retry after a 401).
  const lastFlushedRef = useRef<string | null>(null);

  const resetLabel = language === 'zh' ? '重置' : 'Reset';
  const resetInProgressLabel = language === 'zh' ? '正在重置...' : 'Resetting...';
  const resetTitle =
    language === 'zh'
      ? '移除此字段的数据库 override'
      : 'Remove the database override for this field';
  const canResetOverride =
    mode === 'settings' &&
    meta?.source === 'override' &&
    typeof onCommit === 'function' &&
    localDraft === null;

  const resetOverride = async () => {
    if (!onCommit) return;
    setResetting(true);
    try {
      lastFlushedRef.current = null;
      const result = onCommit('');
      const ok = result && typeof result === 'object' && 'then' in result ? await result : result;
      if (ok !== false) {
        setLocalDraft(null);
      }
    } catch (err) {
      rethrowNextErrors(err);
    } finally {
      setResetting(false);
    }
  };

  // Flush the local draft to onCommit (settings mode). Called from both
  // onBlur and Enter keydown. The host's onCommit returns Promise<bool>
  // (preferred) or void; we clear localDraft only on a true resolution
  // so a commit failure preserves the typed value for retry. With the
  // old design (unconditional 800ms timer), a >800ms server roundtrip
  // would erase the draft mid-flight, including on failure — defeating
  // the "show typed value for retry" contract documented above.
  const flushDraft = () => {
    if (!onCommit || localDraft === null) return;
    // Empty-string guard: a `commit({key: ''})` flows through the shell
    // wrapper, which normalises non-whitelisted keys to null and the
    // server interprets null as `delete this override`. For IM token /
    // chat_id (not in EMPTY_STRING_ALLOWED_PATTERNS), that silently
    // wipes the user's configured secret. SecretRow gates this with
    // `disabled={hook.draft.length === 0}`; we mirror it here so a
    // type-then-backspace-then-blur doesn't accidentally trash the
    // existing override. AND reset the draft to null + clear the dedupe
    // ref: leaving localDraft='' would keep onEditingChange(true) firing,
    // stranding the field in a phantom "editing" state — the shell's
    // leave-guard prompts on tab close, notify.tsx's dirty mirror keeps
    // the test/action button disabled, and there's no visible control
    // for the user to clear it (the input looks empty already).
    if (localDraft === '') {
      lastFlushedRef.current = null;
      setLocalDraft(null);
      return;
    }
    if (lastFlushedRef.current === localDraft) return; // R7 dedupe
    lastFlushedRef.current = localDraft;
    // Snapshot the value at fire time — Promise.then needs to know which
    // exact draft this commit was for so it can verify the user hasn't
    // typed past it before clearing. Without the snapshot, Promise success
    // would clobber any newer typing.
    const flushed = localDraft;
    const result = onCommit(localDraft);
    if (result && typeof result === 'object' && 'then' in result) {
      result
        .then((ok) => {
          if (!ok) {
            // Failure: keep the draft visible for retry AND reset the
            // dedupe ref so the user can press Enter again with the same
            // value (e.g. transient 502 retry). Without this reset,
            // lastFlushedRef stays sticky and Enter silently no-ops until
            // the user edits the field to dirty the ref.
            lastFlushedRef.current = null;
            return;
          }
          // Success: clear ONLY if the user hasn't moved past the value
          // we just committed. localDraftRef carries the latest value;
          // mismatch means a newer keystroke is in flight and clearing
          // would erase that newer typing.
          if (localDraftRef.current === flushed) {
            setLocalDraft(null);
          }
        })
        .catch((err) => {
          // Rejection (network, NEXT_REDIRECT, etc.): reset the dedupe
          // ref so retry-with-same-value works AND re-throw framework
          // errors via unstable_rethrow so 401 session-expiry redirects
          // propagate to Next's client-side router (otherwise the user
          // stays stranded on settings while the framework wanted to
          // navigate them to /login). Mirrors provider-models-field.tsx
          // and pipeline-step-row.tsx — IM card was the last consumer
          // still swallowing the rejection lane.
          lastFlushedRef.current = null;
          rethrowNextErrors(err);
        });
    } else if (result === true) {
      // Sync `true` (rare — boolean return). Apply the same snapshot
      // check: a synchronous true is still followed by any post-render
      // typing that React batched on top of the event.
      if (localDraftRef.current === flushed) {
        setLocalDraft(null);
      }
    }
    // void / false → keep draft; user reviews the typed value, can retry
    // by clicking back into the input and pressing Enter (lastFlushedRef
    // resets on next onChange so the same value can flush again).
  };

  return (
    <SettingsField
      tagLabels={tagLabels}
      label={label}
      hint={hint}
      env={field.envKey}
      source={meta?.source}
      onReset={canResetOverride ? resetOverride : undefined}
      resetting={resetting}
      resetLabel={resetLabel}
      resetInProgressLabel={resetInProgressLabel}
      resetTitle={resetTitle}
      control={
        <input
          type={isSecret ? 'password' : 'text'}
          className="gp-sinput"
          value={inputValue}
          placeholder={placeholder}
          onChange={(e) => {
            // Always update the local draft so the user sees their typing.
            // Also fire onChange — wizard relies on it for real-time
            // state; settings hosts pass a no-op (onCommit takes over
            // commit responsibility). Resetting the dedupe ref ensures a
            // fresh edit can re-flush even to a value identical to one
            // previously committed (e.g. retry the same token after 401).
            lastFlushedRef.current = null;
            setLocalDraft(e.target.value);
            onChange(e.target.value);
          }}
          onBlur={flushDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // Convenience: Enter behaves like a blur-commit for
              // single-line text/secret inputs. Prevent default so the
              // browser doesn't try to submit an enclosing form.
              e.preventDefault();
              flushDraft();
            }
          }}
        />
      }
    />
  );
}
