'use client';

import type {
  DigestPreset,
  EnvKeyState,
  ImSettingsManifest,
  ManagedEnvKey,
  PluginSettingsContributionDescriptor,
  PluginsSnapshot,
} from '@goldpan/web-sdk';
import { Code2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type PerformRestartResult,
  performRestart as performRestartUnified,
} from '@/components/restart-panel/perform-restart';
import { ToastStack, useToastStack } from '@/components/toast-stack';
import { Btn } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { SettingsSaveBar } from '@/components/ui/settings-save-bar';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { rethrowNextErrors } from '@/lib/rethrow';
import { sanitizeErrorMessage } from '@/lib/sanitize-error';
import { commitEnv } from './actions';
import {
  EnvMappingVisibilityProvider,
  useEnvMappingVisibilityState,
} from './env-mapping-visibility';
import { GroupAbout } from './groups/about';
import { GroupAccount } from './groups/account';
import { GroupAppearance } from './groups/appearance';
import { GroupCollect } from './groups/collect';
import { GroupData } from './groups/data';
import { GroupDigest } from './groups/digest';
import { GroupEmbedding } from './groups/embedding';
import { GroupLLM } from './groups/llm';
import { GroupNotify } from './groups/notify';
import { GroupPlugins } from './groups/plugins';
import { GroupSearch, getEffectiveSearchContributions } from './groups/search';
import { RestartPendingBanner, RestartPrompt } from './restart-prompt';
import {
  configErrorI18nKey,
  GROUP_ENV_KEYS,
  GROUPS,
  INITIAL_MOCK,
  indexEnvState,
  omitKeys,
  pickKeys,
  SECTION_ORDER,
  type SettingsGroupId,
  type SettingsMockSlice,
  type SettingsSectionId,
  type SettingsStore,
} from './settings-data';
import { ChevronIcon, GROUP_ICONS } from './settings-primitives';

const VALID_GROUP_IDS = new Set<string>(GROUPS.map((g) => g.id));
function isSettingsGroupId(value: string): value is SettingsGroupId {
  return VALID_GROUP_IDS.has(value);
}

function currentLocationGroup(): SettingsGroupId | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const queryGroup = url.searchParams.get('group');
  const hashGroup = url.hash.replace(/^#/, '');
  const target = queryGroup ?? hashGroup;
  return target && isSettingsGroupId(target) ? target : null;
}

function currentHrefForGroup(group: SettingsGroupId): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  url.searchParams.set('group', group);
  url.hash = '';
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Env-key suffix patterns whose values legitimately accept the empty string
 * (i.e. `''` is a meaningful committed state, NOT shorthand for "delete the
 * override"). Per-field commit normalisation skips `''→null` for keys
 * matching any of these patterns. See {@link commit} for the full rationale.
 */
const EMPTY_STRING_ALLOWED_PATTERNS: ReadonlyArray<RegExp> = [
  /_MODELS$/,
  /_EMBEDDING_MODELS$/,
  /_PATH$/,
];
function keyAllowsEmptyString(key: string): boolean {
  return EMPTY_STRING_ALLOWED_PATTERNS.some((re) => re.test(key));
}

// One-shot informational dialog shown the first time the user successfully
// commits a settings change in a browser session. Goal: surface the "writes
// land in the DB, not .env" behavior to users who previously edited .env
// directly so they aren't confused when the file no longer reflects their
// UI edits. sessionStorage (NOT localStorage) is intentional — per-tab
// session is forgiving for users who close + reopen the tab and want a
// refresher.
/**
 * Localize a commit/validation error. Cross-field config rules from core carry a
 * stable `code` (config/index.ts) so the user-editable content-length limits show
 * a localized message instead of the raw English fallback. Codeless / unknown
 * errors fall back to the sanitized server message.
 */
function localizeCommitError(
  err: { message?: string; code?: string } | undefined,
  tShell: ReturnType<typeof useTranslations<'settings.shell'>>,
): string {
  const key = configErrorI18nKey(err?.code);
  return key ? tShell(key) : sanitizeErrorMessage(err?.message ?? '');
}

const FIRST_SAVE_STORAGE_KEY = 'goldpan_first_save_seen';

function useFirstSavePrompt() {
  const [show, setShow] = useState(false);
  const trigger = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem(FIRST_SAVE_STORAGE_KEY)) return;
    setShow(true);
  }, []);
  const dismiss = useCallback(() => {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(FIRST_SAVE_STORAGE_KEY, '1');
    }
    setShow(false);
  }, []);
  return { show, trigger, dismiss };
}

interface Props {
  initialDigestEnabled: boolean;
  initialPresets: DigestPreset[];
  initialEnvItems: EnvKeyState[];
  envStateError: string | null;
  manifests: ImSettingsManifest[];
  contributions: PluginSettingsContributionDescriptor[];
  contributionsError?: string | null;
  language: 'en' | 'zh';
  initialPluginsSnapshot: PluginsSnapshot;
  pluginsError: string | null;
  initialPendingRestartKeys?: string[];
}

export function SettingsShell({
  initialDigestEnabled,
  initialPresets,
  initialEnvItems,
  envStateError,
  manifests,
  contributions,
  contributionsError = null,
  language,
  initialPluginsSnapshot,
  pluginsError,
  initialPendingRestartKeys = [],
}: Props) {
  const searchParams = useSearchParams();
  const t = useTranslations('settings.a11y');
  const tShell = useTranslations('settings.shell');
  const tFirstSave = useTranslations('settings.first_save');
  const tActions = useTranslations('settings.actions');
  const exportHintId = useId();

  const SECTION_LABEL = useMemo<Record<SettingsSectionId, string>>(
    () => ({
      workspace: tShell('section_workspace'),
      ai: tShell('section_ai'),
      sources: tShell('section_sources'),
      push: tShell('section_push'),
      system: tShell('section_system'),
    }),
    [tShell],
  );
  const GROUP_LABEL = useMemo<Record<SettingsGroupId, string>>(
    () => ({
      account: tShell('group_account'),
      data: tShell('group_data'),
      appearance: tShell('group_appearance'),
      llm: tShell('group_llm'),
      embedding: tShell('group_embedding'),
      plugins: tShell('group_plugins'),
      collect: tShell('group_collect'),
      search: tShell('group_search'),
      notify: tShell('group_notify'),
      digest: tShell('group_digest'),
      about: tShell('group_about'),
    }),
    [tShell],
  );

  // Note: `digestEnabled` is plugin AVAILABILITY (from `listDigestPresetsCached`
  // probe), NOT the user-facing GOLDPAN_DIGEST_ENABLED env flag. The two are
  // distinct concepts:
  // - `store.digestEnabled = false` → plugin not registered → render DigestDisabledCard
  // - `env.get('GOLDPAN_DIGEST_ENABLED')?.mask` → user enabled the pipeline
  //   (Phase 4 Task 20 wires the toggle inside the main flow once plugin is registered)
  // Don't try to derive one from the other.
  const [store, setStore] = useState<SettingsStore>(() => ({
    env: indexEnvState(initialEnvItems),
    dirty: {},
    mock: INITIAL_MOCK,
    digestEnabled: initialDigestEnabled,
    presets: initialPresets,
    pluginsSnapshot: initialPluginsSnapshot,
  }));
  const [group, setGroup] = useState<SettingsGroupId>(initialDigestEnabled ? 'digest' : 'plugins');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [pendingNav, setPendingNav] = useState<SettingsGroupId | null>(null);
  const [pendingNavOptions, setPendingNavOptions] = useState<NavigateOptions | null>(null);
  const [pendingNavRollbackUrl, setPendingNavRollbackUrl] = useState<string | null>(null);
  // One-shot hint consumed by GroupLLM to pick which tab to mount on. Cleared
  // automatically when the active group leaves 'llm' so re-entering LLM later
  // without a hint falls back to the default 'providers' tab.
  const [llmInitialTab, setLlmInitialTab] = useState<LlmSettingsTab | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  // Pending-restart state has two axes:
  //   - `restartPromptKeys` (null | string[]): the *accumulated* set of keys
  //     that have committed but the server hasn't restarted to pick up yet.
  //     Grows as the user saves / resets more restart-required fields. Cleared
  //     only by a successful restart (page reload wipes the in-memory set).
  //   - `restartModalOpen` (boolean): whether the confirmation modal is open
  //     right now. Decoupled from `keys` so that dismissing the modal ("稍后")
  //     does NOT wipe the accumulated set — instead a sticky banner stays
  //     visible offering a re-open path, mirroring the server's own pending
  //     state (`/health.pendingRestartKeys` survives the dismissal).
  // Each new commit response that brings restart-required keys merges into
  // the accumulator (dedup) and re-opens the modal.
  const [restartPromptKeys, setRestartPromptKeys] = useState<string[] | null>(() =>
    initialPendingRestartKeys.length > 0 ? [...initialPendingRestartKeys] : null,
  );
  const [restartModalOpen, setRestartModalOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // Reconcile pending-restart accumulator against a commit result. Scoped
  // keys NOT returned in `incoming` were resolved by the server (e.g. the
  // user toggled a value back to baseline, removing the need for a restart);
  // we must subtract them so the modal/banner stops nagging about a key the
  // server no longer cares about. Merges incoming, then subtracts scoped\incoming.
  const reconcileRestartKeys = useCallback(
    (
      scopedKeys: ReadonlyArray<string>,
      incoming: ReadonlyArray<string>,
      options?: { openModal?: boolean },
    ) => {
      setRestartPromptKeys((prev) => {
        const next = new Set<string>(prev ?? []);
        for (const k of incoming) next.add(k);
        const incomingSet = new Set(incoming);
        for (const k of scopedKeys) {
          if (!incomingSet.has(k)) next.delete(k);
        }
        return next.size === 0 ? null : [...next];
      });
      if (incoming.length > 0 && options?.openModal !== false) {
        setRestartModalOpen(true);
      }
    },
    [],
  );
  const firstSave = useFirstSavePrompt();
  const envMappingVisibility = useEnvMappingVisibilityState();

  const { toasts, api } = useToastStack();
  const toast = api.push;

  const commitAttemptRef = useRef(0);
  const latestCommitAttemptByKeyRef = useRef<Record<string, number>>({});
  const beginCommitAttempt = useCallback((keys: ReadonlyArray<string>) => {
    const attempt = commitAttemptRef.current + 1;
    commitAttemptRef.current = attempt;
    for (const key of keys) {
      latestCommitAttemptByKeyRef.current[key] = attempt;
    }
    return attempt;
  }, []);
  const freshKeysForAttempt = useCallback((attempt: number, keys: ReadonlyArray<string>) => {
    return keys.filter((key) => latestCommitAttemptByKeyRef.current[key] === attempt);
  }, []);

  // Deep-link via ?group= or # — re-run when the query changes so in-app links
  // (e.g. restart tag → /settings?group=about) actually switch the sidebar
  // group. Routes through requestNavigateRef (mirrored below) so the leave-
  // guard recognises dirty / in-flight / editing state and prompts the
  // confirm modal — pre-fix, `setGroup(target)` bypassed hasNavBlocker and
  // a user with an in-progress auto-commit draft would lose it silently
  // when a deep-link or hashchange fired (e.g. the restart tag in
  // use-field-tag-labels.tsx pointing at /settings?group=about). Initial
  // mount with hasNavBlocker=false is unaffected — requestNavigate falls
  // through to plain setGroup when no blocker is active.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncFromUrl = () => {
      const queryGroup = searchParams.get('group');
      const hashGroup = window.location.hash.replace(/^#/, '');
      const target = queryGroup ?? hashGroup;
      if (target && isSettingsGroupId(target)) {
        requestNavigateRef.current?.(target);
      }
    };
    syncFromUrl();
    window.addEventListener('hashchange', syncFromUrl);
    return () => window.removeEventListener('hashchange', syncFromUrl);
  }, [searchParams]);
  // Ref-mirror for requestNavigate. Defined here so the URL effect above can
  // call the latest implementation without forcing the effect's deps to
  // include requestNavigate (which would tear down + recreate the hashchange
  // listener every time hasNavBlocker flipped). The sync assignment below
  // (after requestNavigate is declared) updates this ref every render.
  const requestNavigateRef = useRef<
    ((next: SettingsGroupId, options?: NavigateOptions) => void) | null
  >(null);

  // One-shot env-state load failure banner
  useEffect(() => {
    if (envStateError !== null) {
      toast({
        msg: `${tShell('env_state_load_failed')}: ${envStateError}`,
        kind: 'danger',
      });
    }
  }, [envStateError, toast, tShell]);

  // One-shot plugins-load failure banner — reuse the same toast slot pattern.
  // Page.tsx already short-circuits to /login on 401, so when this runs the
  // error is some other transport / 5xx; surfacing it as a toast keeps the
  // page rendered (with empty plugin list) instead of throwing 500.
  useEffect(() => {
    if (pluginsError !== null) {
      toast({
        msg: `${tShell('plugins_load_failed')}: ${pluginsError}`,
        kind: 'danger',
      });
    }
  }, [pluginsError, toast, tShell]);

  // notify group 的 envKeys 由 manifest 动态派生（每个 IM channel 贡献
  // enable.envKey + 所有 fields[].envKey），合并 GROUP_ENV_KEYS.notify 静态
  // 部分（目前为空，留作未来非 plugin 字段的占位）。
  // 没有动态合并就会出现 inline B 描述的 bug：用户编辑 manifest 字段（如
  // encryptKey 等）触发 patch，但 groupDirty 把它过滤掉，saveBar 永不出现。
  const notifyKeys = useMemo(() => {
    const set = new Set<string>(GROUP_ENV_KEYS.notify);
    for (const m of manifests) {
      set.add(m.enable.envKey);
      for (const f of m.fields) set.add(f.envKey);
    }
    return [...set];
  }, [manifests]);
  // search group 的 envKeys 走新的 contribution 协议派生：每个 search plugin
  // 贡献 enable?.envKey + 所有 fields[].envKey。这样 plugin 新增字段时
  // settings-shell 自动接管 dirty / save scope，不再需要在 GROUP_ENV_KEYS 里
  // 维护一份 hardcoded 列表。
  const searchKeys = useMemo(() => {
    const set = new Set<string>(GROUP_ENV_KEYS.search);
    for (const c of getEffectiveSearchContributions(contributions)) {
      if (c.enable !== undefined) set.add(c.enable.envKey);
      for (const f of c.fields) set.add(f.envKey);
    }
    return [...set];
  }, [contributions]);
  const digestKeys = useMemo(() => {
    const set = new Set<string>(GROUP_ENV_KEYS.digest);
    for (const c of contributions) {
      if (c.group !== 'digest') continue;
      if (c.enable !== undefined) set.add(c.enable.envKey);
      for (const f of c.fields) set.add(f.envKey);
    }
    return [...set];
  }, [contributions]);
  // LLM group 还包含动态 `GOLDPAN_LLM_PROVIDER_<ID>_{BASE_URL,API_KEY_ENV,MODELS}` 形态
  // (Provider 页 builtin model 列表 + custom provider 编辑都用这套命名)，以及
  // per-step reasoning options `GOLDPAN_LLM_<STEP>_<PROVIDER>_OPTIONS`（思考模式
  // 高级面板写入；STEP/PROVIDER 集合见 packages/core/src/llm/reasoning-tiers.ts）。
  // 把当前 dirty 中匹配这两条 pattern 的 key 合并进 group 范围，否则用户编辑会:
  //   1) 不在 groupDirty → save 不带这些 key (数据丢失)
  //   2) 不算到 dirtyByGroup.llm → 侧栏 dot 不亮 / save bar 不出现
  // notifyKeys 走 manifest 派生路径不一样，不能复用同一套；这里独立处理。
  const llmKeys = useMemo<ReadonlyArray<string>>(() => {
    const set = new Set<string>(GROUP_ENV_KEYS.llm);
    for (const k of Object.keys(store.dirty)) {
      if (
        /^GOLDPAN_LLM_PROVIDER_[A-Z][A-Z0-9_]*_(BASE_URL|API_KEY_ENV|MODELS)$/.test(k) ||
        /^GOLDPAN_LLM_(CLASSIFIER|EXTRACTOR|MATCHER|COMPARATOR|VERIFIER|RELATOR|TRANSLATOR|INTENT|QUERY|DIGEST_SUMMARY|DIGEST_ACTION)_(ANTHROPIC|OPENAI|GOOGLE|DEEPSEEK)_OPTIONS$/.test(
          k,
        )
      ) {
        set.add(k);
      }
    }
    return [...set];
  }, [store.dirty]);
  const groupKeys = useMemo<ReadonlyArray<string>>(
    () =>
      group === 'notify'
        ? notifyKeys
        : group === 'llm'
          ? llmKeys
          : group === 'search'
            ? searchKeys
            : group === 'digest'
              ? digestKeys
              : GROUP_ENV_KEYS[group],
    [group, notifyKeys, llmKeys, searchKeys, digestKeys],
  );
  const groupDirty = useMemo(() => pickKeys(store.dirty, groupKeys), [store.dirty, groupKeys]);
  const hasGroupDirty = Object.keys(groupDirty).length > 0;
  const hasAnyDirty = Object.keys(store.dirty).length > 0;

  // Per-field auto-commit pilot bypasses the legacy `store.dirty` tracker
  // (toggles / direct-save inputs don't `patch()` — they call commit() /
  // hook.save() directly). That leaves two windows where a user could
  // switch groups / close the tab without warning and silently lose work:
  //
  //   - in-flight commit: hook fired commit() but server hasn't responded.
  //     If Account unmounts mid-flight, the hook's mount guard suppresses
  //     setState on resolve, so even a failure can't surface inline (the
  //     shell-level toast still fires — covered in commit() catch — but
  //     the user has already navigated away).
  //
  //   - editing-but-unsubmitted draft: password edit form is open with
  //     typed-in values that haven't been Save'd yet (or were Save'd and
  //     failed, leaving editPwd=true). store.dirty doesn't track this
  //     because account.tsx doesn't `patch()`.
  //
  // Both states are surfaced via these two trackers and merged into the
  // navigation/unload guard below. Group components mark their local
  // editing state via `setFieldEditing(envKey, true/false)`; commit-driven
  // in-flight is tracked transparently inside this shell's commit handler.
  // Per-key in-flight counter. Set-based de-duplication (the previous design)
  // mis-handled concurrent commits to the same key: commit#1 + commit#2 both
  // add 'K' to the set; commit#1 resolves → `filter(k => k !== 'K')` removes
  // 'K' even though commit#2 is still in flight, and the leave-guard goes
  // green while a write is mid-air. Counting fixes that — the key stays
  // "in-flight" until ALL outstanding commits to it have resolved.
  const [inFlightCounts, setInFlightCounts] = useState<Readonly<Record<string, number>>>({});
  const [editingFields, setEditingFields] = useState<readonly string[]>([]);

  const beginInFlight = useCallback((keys: ReadonlyArray<string>) => {
    setInFlightCounts((prev) => {
      const next: Record<string, number> = { ...prev };
      for (const k of keys) next[k] = (next[k] ?? 0) + 1;
      return next;
    });
  }, []);
  const endInFlight = useCallback((keys: ReadonlyArray<string>) => {
    setInFlightCounts((prev) => {
      const next: Record<string, number> = { ...prev };
      for (const k of keys) {
        const c = (next[k] ?? 0) - 1;
        if (c <= 0) delete next[k];
        else next[k] = c;
      }
      return next;
    });
  }, []);
  // Read-only Set view for consumers (group components reading
  // `group.inFlightKeys.has(envKey)` to disable action buttons during writes).
  const inFlightKeys = useMemo<ReadonlySet<string>>(
    () => new Set(Object.keys(inFlightCounts)),
    [inFlightCounts],
  );

  const setFieldEditing = useCallback((envKey: string, editing: boolean) => {
    setEditingFields((prev) => {
      if (editing) {
        return prev.includes(envKey) ? prev : [...prev, envKey];
      }
      // CRITICAL: bail-out when envKey isn't tracked. `prev.filter(...)`
      // always allocates a fresh array even when nothing matches, so
      // returning it would defeat React's Object.is-equal setState
      // shortcut → forced re-render every time a non-tracked field
      // signals editing=false. With the (now-multi-call-per-render)
      // useEffect-based wiring in TextSecretField, that chain becomes
      // an unbounded render loop and notify.tsx crashes with "Maximum
      // update depth exceeded". Mirror the editing=true branch's
      // `includes ? same : new` guard so a no-op is truly a no-op.
      return prev.includes(envKey) ? prev.filter((k) => k !== envKey) : prev;
    });
  }, []);

  const hasInFlight = inFlightKeys.size > 0;
  const hasEditing = editingFields.length > 0;
  // hasNavBlocker = anything that should prompt the leave-modal before a
  // group switch. Three buckets: legacy SaveBar dirty, per-field in-flight
  // commit, per-field unsaved draft. Any one is enough to block.
  const hasNavBlocker = hasGroupDirty || hasInFlight || hasEditing;

  const patch = useCallback((key: string, value: string) => {
    setStore((s) => ({ ...s, dirty: { ...s.dirty, [key]: value } }));
  }, []);

  const applyEnvItems = useCallback((items: EnvKeyState[]) => {
    const keys = items.map((item) => item.key);
    setStore((s) => {
      const nextEnv = new Map(s.env);
      for (const item of items) nextEnv.set(item.key as ManagedEnvKey, item);
      return { ...s, env: nextEnv, dirty: omitKeys(s.dirty, keys) };
    });
  }, []);

  // Single-key commit helper for the new auto-commit field pattern (account
  // pilot etc). Shares the same server pipeline as `save` — pendingRestart
  // merge + firstSave + env-state update — but driven per-field, not via
  // dirty store. Returns the raw CommitEnvResult so the calling hook
  // (useToggleCommit / useEditableCommit) can route on errors / restart.
  //
  // The LLM-timeout empty-string → null coercion mirrors the legacy `save`
  // path — applied here so a per-field commit of "" also hits the right
  // "reset to baseline" semantics on the server.
  const commit = useCallback<
    (patch: Record<string, string | null>) => Promise<import('@goldpan/web-sdk').CommitEnvResult>
  >(
    async (patch) => {
      const scoped: Record<string, string | null> = { ...patch };
      // Empty-string → null normalisation, with an opt-out whitelist for
      // keys that legitimately accept `''` as a meaningful value.
      //
      // WHY normalise at all:
      //   - `z.url()` keys (OLLAMA_BASE_URL etc.) reject '' → server 400.
      //   - `z.coerce.number().positive()` keys (GOLDPAN_*_TIMEOUT,
      //     EMBEDDING_BATCH_SIZE, COLLECT_TIMEOUT, ...) coerce '' → 0
      //     then reject for being non-positive → server 400.
      //   - `z.coerce.number().nonnegative()` keys (EMBEDDING_DIMENSIONS)
      //     silently accept '' → 0, writing a semantically wrong override.
      //   - Toggle keys ('true' / 'false') reject '' outright.
      // Routing '' → null for these keys hits `configStore.delete()` on
      // the server, matching the Reset button semantics — which is what
      // the user expects when they clear a field.
      //
      // WHY the whitelist exception:
      //   - `*_MODELS` / `*_EMBEDDING_MODELS` parse as comma-separated lists;
      //     '' means "no model in this slot", a first-class state — losing
      //     this would force users into "delete the last model = revert to
      //     .env's old models" rather than "delete the last model = no
      //     models". add-openai-compat-modal.test.tsx asserts this contract.
      //   - `*_PATH` (BROWSER_EXECUTABLE_PATH, YT_DLP_*_PATH) are
      //     `z.string().optional()` — '' means "no path", distinct from
      //     "delete override (fall back to .env)". Without the exception,
      //     a user who clears a UI path in the presence of a stale .env
      //     value would see the .env value silently restored.
      for (const [key, value] of Object.entries(scoped)) {
        if (value === '' && !keyAllowsEmptyString(key)) {
          scoped[key] = null;
        }
      }
      const scopedKeys = Object.keys(scoped);
      const attempt = beginCommitAttempt(scopedKeys);
      // Track this commit as in-flight so the leave-guard knows to prompt
      // before the user navigates away (or closes the tab) mid-request.
      // Without this, an auto-commit toggle / direct-save mid-flight could
      // be silently abandoned — the hook bails on its mount guard and the
      // user never sees the result inline.
      beginInFlight(scopedKeys);
      try {
        const result = await commitEnv(scoped);
        if (result.kind === 'ok') {
          firstSave.trigger();
          const freshKeys = freshKeysForAttempt(attempt, scopedKeys);
          const freshKeySet = new Set(freshKeys);
          if (freshKeys.length > 0) {
            setStore((s) => {
              const nextEnv = new Map(s.env);
              for (const item of result.updatedItems) {
                if (freshKeySet.has(item.key)) {
                  nextEnv.set(item.key as never, item);
                }
              }
              return {
                ...s,
                env: nextEnv,
                // Clear any legacy dirty entry for these keys so the
                // SaveBar (still serving non-migrated groups) doesn't see
                // stale state after our auto-commit path lands. Stale
                // resolves are ignored per-key so an older response can't
                // overwrite a newer auto-commit that already superseded it.
                dirty: omitKeys(s.dirty, freshKeys),
              };
            });
          }
          // Use reconcile so a per-field commit that resolved a previously
          // pending key (e.g. user toggles SSRF back to baseline) subtracts
          // it from the accumulator instead of leaving the banner stuck.
          reconcileRestartKeys(
            freshKeys,
            result.pendingRestartKeys.filter((key) => freshKeySet.has(key)),
          );
          // Note: no toast on success — the field's status indicator handles
          // user-facing feedback. (The legacy `save` path toasts because the
          // SaveBar lives at the bottom of the page and the user needs
          // separate acknowledgement.)
        } else {
          // Server-validation failure (kind === 'errors'). Two sub-cases:
          //
          // (a) Own / general error — `errors[].path` matches one of the
          //     scoped keys (or is empty). FieldStatus inline will render
          //     the message via pickErrorForField, so the toast stays SHORT
          //     to avoid showing the same text twice in two surfaces.
          //
          // (b) Cross-field error — `errors[].path` points at OTHER keys
          //     only. The hook's pickErrorForField deliberately falls back
          //     to 'unknown' (showing another key's message in this field's
          //     red row would mislead about which input was rejected), so
          //     the toast is the ONLY surface that can convey the real
          //     reason. Send the first cross-field message through
          //     `save_errors_toast` (with sanitization for self-host
          //     paste-safety).
          //
          // Either way `console.warn` logs the full errors array so ops
          // can diagnose without depending on toast persistence.
          console.warn('[settings] per-field commit returned errors', result.errors);
          // Stale-attempt guard, mirroring the success path above: if every
          // key in this commit has since been superseded by a newer commit
          // on the same key, that newer attempt owns the user-facing outcome.
          // Skip the toast so an older rejection can't contradict a newer
          // success (console.warn above still records the full errors for ops).
          if (freshKeysForAttempt(attempt, scopedKeys).length === 0) {
            return result;
          }
          const scopedKeySet = new Set(scopedKeys);
          const hasOwnError = result.errors.some((e) => scopedKeySet.has(e.path) || e.path === '');
          if (hasOwnError) {
            toast({ msg: tShell('save_failed_toast'), kind: 'danger' });
          } else {
            const detail = localizeCommitError(result.errors[0], tShell);
            toast({
              msg: tShell('save_errors_toast', { message: detail }),
              kind: 'danger',
            });
          }
        }
        return result;
      } catch (err) {
        rethrowNextErrors(err);
        console.error('[settings] per-field commit failed', err);
        // Same short toast rationale as errors-result — FieldStatus renders
        // err.message via the hook's catch when mounted. Console keeps the
        // full diagnostic for self-host operators. Stale-attempt guard: a
        // newer commit on the same key already owns the outcome, so suppress
        // the toast for a superseded attempt (still re-throw — the hook's
        // superseded check ignores it, and a live attempt must land in
        // catch → state='error').
        if (freshKeysForAttempt(attempt, scopedKeys).length > 0) {
          toast({ msg: tShell('save_failed_toast'), kind: 'danger' });
        }
        // Re-throw so the hook lands in catch → state='error'.
        throw err;
      } finally {
        // Always clear the in-flight marker, even on throw — leaving it
        // set would leave the leave-guard nagging about a phantom commit.
        endInFlight(scopedKeys);
      }
    },
    [
      firstSave,
      reconcileRestartKeys,
      toast,
      tShell,
      beginInFlight,
      endInFlight,
      beginCommitAttempt,
      freshKeysForAttempt,
    ],
  );

  const reset = useCallback(() => {
    setStore((s) => ({ ...s, dirty: omitKeys(s.dirty, groupKeys) }));
  }, [groupKeys]);

  const updateMock = useCallback((mut: (m: SettingsMockSlice) => Partial<SettingsMockSlice>) => {
    setStore((s) => ({ ...s, mock: { ...s.mock, ...mut(s.mock) } }));
  }, []);

  const save = useCallback(async () => {
    if (!hasGroupDirty || saving) return;
    setSaving(true);
    const scoped: Record<string, string | null> = { ...groupDirty };
    // Mirror the per-field commit's empty-string normalisation (see line
    // 474 / keyAllowsEmptyString helper). save() is currently dead code
    // (no group writes to dirty store any more) but kept for plugin /
    // future-callsite compatibility — match the auto-commit semantics so
    // the two paths stay equivalent. WITHOUT the whitelist check, a
    // future plugin that revives the SaveBar path and submits e.g.
    // `_MODELS: ''` (which is a valid "no models configured" intent
    // server-side) would have the empty string silently coerced to null,
    // deleting the override and falling back to .env / default — opposite
    // of the user's expressed intent. Stays a single source of truth.
    for (const [key, value] of Object.entries(scoped)) {
      if (value === '' && !keyAllowsEmptyString(key)) {
        scoped[key] = null;
      }
    }
    const scopedKeys = Object.keys(scoped);
    try {
      const result = await commitEnv(scoped);
      if (result.kind === 'ok') {
        firstSave.trigger();
        setStore((s) => {
          const nextEnv = new Map(s.env);
          for (const item of result.updatedItems) {
            // Server returns the freshly-built EnvKeyState for each committed
            // key (source = 'override' since commit just persisted a DB
            // override; baselineDiffers reflects whether bootEnv still
            // disagrees). No prev-state preservation needed — overrides apply
            // immediately and the new shape is authoritative.
            nextEnv.set(item.key as never, item);
          }
          return {
            ...s,
            env: nextEnv,
            // Only clear keys that were actually committed. Keys edited
            // during the round-trip stay dirty so the user's new edits
            // aren't silently lost.
            dirty: omitKeys(s.dirty, scopedKeys),
          };
        });
        // Reconcile so keys whose restart-need was resolved by this batch
        // (user reverted a value back to baseline) drop out of the prompt.
        reconcileRestartKeys(scopedKeys, result.pendingRestartKeys);
        if (result.pendingRestartKeys.length === 0) {
          // Highlight the "baseline still disagrees" case so the user knows a
          // future override-reset would re-shadow with the .env value.
          const hasBaselineDiff = result.updatedItems.some(
            (item) => item.source === 'override' && item.baselineDiffers === true,
          );
          toast({
            msg: tShell(hasBaselineDiff ? 'saved_shadowed_toast' : 'saved_restart_toast'),
            kind: hasBaselineDiff ? 'danger' : 'success',
          });
        }
      } else {
        toast({
          msg: tShell('save_errors_toast', {
            message: localizeCommitError(result.errors[0], tShell),
          }),
          kind: 'danger',
        });
      }
    } catch (err) {
      // NEXT_REDIRECT (e.g. SDK onUnauthorized triggering /login) must
      // propagate so Next can navigate; only genuine network / unexpected
      // errors land in the local toast path. Use save_errors_toast with
      // err.message (not the generic save_network_error_toast) so users see
      // the real reason — legacy SaveBar has no per-field FieldStatus to
      // carry the detail, so toast is the only surface.
      //
      // Sanitize the message first: self-host operators commonly paste
      // toast text into bug reports, and raw Node fetch errors leak the
      // internal hostname + port (see lib/sanitize-error.ts). Full stack
      // is still preserved on console.error for the maintainer side.
      rethrowNextErrors(err);
      console.error('[settings] commitEnv save failed', err);
      toast({
        msg: tShell('save_errors_toast', { message: sanitizeErrorMessage(err) }),
        kind: 'danger',
      });
    } finally {
      setSaving(false);
    }
  }, [hasGroupDirty, saving, groupDirty, toast, tShell, firstSave, reconcileRestartKeys]);

  // Per-key reset: deletes the runtime override for `key` and reverts to the
  // baseline / default. Bypasses the dirty / save-bar flow because reset is a
  // single-key intent — there's no draft to merge with. After commit, the
  // returned EnvKeyState replaces the row in `store.env` so the OriginBadge
  // re-renders with the new source ('env' or 'default') and the reset button
  // disappears. Also clears any pending dirty edit for that key so the user
  // doesn't end up with a stale draft of the value they just reverted.
  //
  // Returns true when the reset persisted, false on validation/network
  // failure. Callers that follow up with side-effects on the field's hook
  // state (e.g. account.tsx → `pwdCommit.clear()`) need this to skip those
  // side-effects on failure — unconditionally clearing creates a UI where
  // the field looks reset even though the server kept the old override.
  const resetEnvKey = useCallback(
    async (key: string): Promise<boolean> => {
      // Participate in beginInFlight/endInFlight accounting alongside the
      // auto-commit path: pre-fix, reset ran without in-flight tracking, so
      // (a) the leave-guard / beforeunload thought no commit was mid-air
      //     during the network roundtrip and would let the tab close, and
      // (b) a sibling auto-commit on the same key wouldn't see Reset as
      //     "in flight" → both could fire concurrently → last-write-wins
      //     between the reset and the optimistic commit.
      const attempt = beginCommitAttempt([key]);
      beginInFlight([key]);
      try {
        const result = await commitEnv({ [key]: null });
        if (result.kind === 'ok') {
          firstSave.trigger();
          const freshKeys = freshKeysForAttempt(attempt, [key]);
          if (freshKeys.length === 0) {
            return true;
          }
          setStore((s) => {
            const nextEnv = new Map(s.env);
            for (const item of result.updatedItems) {
              if (item.key === key) nextEnv.set(item.key as never, item);
            }
            return {
              ...s,
              env: nextEnv,
              dirty: omitKeys(s.dirty, freshKeys),
            };
          });
          // Reconcile: a reset that brings the value back to a state where
          // restart isn't needed (server returns []) must subtract the key
          // from the accumulator, otherwise an earlier override's restart
          // notice would stay stuck after the override was removed.
          reconcileRestartKeys(
            freshKeys,
            result.pendingRestartKeys.filter((pendingKey) => pendingKey === key),
          );
          if (result.pendingRestartKeys.length === 0) {
            toast({ msg: tActions('reset_success_toast'), kind: 'success' });
          }
          return true;
        }
        toast({
          msg: tActions('reset_error_toast', {
            message: localizeCommitError(result.errors[0], tShell),
          }),
          kind: 'danger',
        });
        return false;
      } catch (err) {
        rethrowNextErrors(err);
        console.error('[settings] commitEnv reset failed', err);
        toast({ msg: tActions('reset_network_error_toast'), kind: 'danger' });
        return false;
      } finally {
        endInFlight([key]);
      }
    },
    [
      toast,
      tActions,
      firstSave,
      reconcileRestartKeys,
      beginInFlight,
      endInFlight,
      beginCommitAttempt,
      freshKeysForAttempt,
      tShell,
    ],
  );

  // Trigger a browser download of the current DB overrides as a .env snippet.
  // The server endpoint streams `text/plain` plus a `Content-Disposition`
  // header; the SDK extracts both. We can't route this through a server
  // action — the file save dialog is a browser-only side effect (Blob +
  // anchor.click()) and the bytes need to land in the user's filesystem,
  // not on the Next.js server.
  const handleExportOverrides = useCallback(async () => {
    try {
      const client = getBrowserApiClient();
      const { text, filename } = await client.exportOverrides();
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ msg: tActions('export_success_toast'), kind: 'success' });
    } catch (err) {
      console.error('[settings] exportOverrides failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      toast({ msg: tActions('export_error_toast', { message: msg }), kind: 'danger' });
    }
  }, [toast, tActions]);

  // Thin wrapper over the shared `performRestart` helper. Used by:
  //   - onRestartConfirm (the standard RestartPrompt confirmation path)
  //   - resetEnvKeyAndRestart (account "reset password" one-shot path where
  //     the caller's own confirm modal already explained the restart and we
  //     don't want RestartPrompt to also pop up on top).
  //
  // The unified helper owns the whole lifecycle: setRestartFlag → POST
  // (tolerating connection drop) → pollForReady → window.location reload
  // / assign. Previously settings had its own duplicate implementation
  // that diverged on three points — no restart flag (so app/error.tsx
  // didn't recognise the mid-restart window), no connection-drop
  // tolerance (so an expected response-flush failure was reported as
  // "restart failed" while the restart had actually started), and reload-
  // only. Sharing one helper closes those gaps and keeps the standalone
  // RestartPanel and the settings driver behaviourally identical.
  //
  // pollForReady's K-consecutive-OK + SSR-path-probe loop is the same
  // algorithm RestartPanel uses on /settings#about and
  // /onboarding/complete, so locale survival (the SSR i18n loader can't
  // race a half-ready server) holds across all paths.
  const performRestart = useCallback(
    async (onPolling?: () => void): Promise<PerformRestartResult> => {
      return performRestartUnified({ onPolling });
    },
    [],
  );

  // Restart-prompt confirm: drive performRestart with toast / modal hand-off.
  const tRestart = useTranslations('settings.restart_prompt');
  const onRestartConfirm = useCallback(async () => {
    if (restartPromptKeys === null) return;
    setRestarting(true);
    // Show a transient "restarting…" toast so the user sees feedback before
    // the page reload — the modal stays mounted (with the inProgress label)
    // until the reload kicks in. Toast kind defaults to neutral (no
    // success / danger styling) since the restart hasn't completed yet.
    const r = await performRestart(() => {
      toast({ msg: tRestart('in_progress') });
    });
    if (r.ok) {
      // Page is about to reload. Do NOT setRestarting(false) — flipping the
      // button back to "Restart now" mid-shutdown would tempt a double-trigger.
      return;
    }
    if (r.reason === 'timeout') {
      // 60s window expired without /health succeeding. Don't force-reload
      // into a server that hasn't come back — surface the failure so the
      // modal can be dismissed and the user can retry manually. Use the
      // shorter `timeout` key (not `failed`) — pollForReady's exhaustion
      // is not the same as "restart failed". Self-host users on slower
      // hardware (NAS / Pi / cold image cache) routinely need >60s to
      // come back; calling it "failed" prompts unnecessary log diving.
      // The phrasing hints at recovery via manual refresh.
      toast({ msg: tRestart('timeout'), kind: 'danger' });
      setRestartModalOpen(false);
    } else {
      // post_failed: server returned a 4xx/5xx response to POST
      // /server/restart — actively refused (e.g. another restart already
      // in flight, restart disabled by env). Use the `failed` i18n key
      // which already includes a "查看 supervisor 日志" hint. (A
      // `failed_with_detail` key used to interpolate a sanitized
      // err.message; it was deleted after the unified helper landed
      // because the POST surface only distinguishes ok vs not-ok and
      // no useful message text is available client-side. Operators see
      // the actual server response in the network panel / server logs.)
      toast({ msg: tRestart('failed'), kind: 'danger' });
    }
    setRestarting(false);
  }, [restartPromptKeys, toast, tRestart, performRestart]);

  // "稍后": close the modal but keep `restartPromptKeys` populated so the
  // sticky pending-restart banner stays visible and offers a re-open path. The
  // server's `pendingRestartKeysSet` continues to track these keys process-wide,
  // so dismissing without restart is recoverable, not lossy.
  const onRestartCancel = useCallback(() => {
    setRestartModalOpen(false);
    setRestarting(false);
  }, []);
  const onRestartReopen = useCallback(() => {
    setRestartModalOpen(true);
  }, []);

  // One-shot "reset env key and immediately restart" used by callers that
  // already have their own confirm modal (currently account.tsx for the login
  // password reset). Deliberately does NOT call reconcileRestartKeys — the
  // caller's modal is already explaining the restart, so we don't want the
  // shell-level RestartPrompt to also pop up on top. Returns a tagged result
  // so the caller can drive its own progress / error UI; on success the page
  // reloads from inside performRestart() and this never resolves to ok=true
  // visibly (the resolved value is here only to satisfy the type).
  const resetEnvKeyAndRestart = useCallback(
    async (
      key: string,
      onPhase?: (phase: 'restart-requested' | 'restart-polling') => void,
    ): Promise<
      | { kind: 'reset-failed'; reason: 'errors' | 'network'; message?: string }
      | { kind: 'restart-failed'; reason: 'timeout' | 'failed'; message?: string }
      | { kind: 'success' }
    > => {
      let updatedItems: EnvKeyState[];
      let pendingRestartKeysFromCommit: readonly string[] = [];
      // The reset's DB write is the only thing worth gating with the leave-
      // guard, so wrap ONLY the commit in beginInFlight/endInFlight and release
      // it BEFORE performRestart (see the `finally` below). performRestart ends
      // in window.location.reload(); if AUTH_PASSWORD were still `in-flight`
      // then, `hasInFlight` would keep the unsaved-edit beforeunload guard armed
      // and that reload would trip it — popping a spurious "Leave site? changes
      // may not be saved" prompt on an action the user explicitly initiated, and
      // a "Stay" click would strand them on a stale page pointing at an
      // already-restarted server. There is nothing to protect during the restart
      // poll anyway: the reset has already persisted server-side and the restart
      // completes regardless of the tab, so a close mid-poll loses no work.
      // (This deliberately narrows the in-flight window that an earlier revision
      // held for the reset's full lifetime — see git history.)
      //
      // Stamp the commit-attempt counter too (parity with commit() /
      // resetEnvKey()) so an EARLIER in-flight commit on this key sees its
      // own result as stale and won't clobber this reset's write. setStore
      // below stays unconditional: reset+restart is terminal (page reloads on
      // success) and account's UI gates commit vs reset as mutually exclusive,
      // so no NEWER attempt can race ahead to make this write stale.
      beginCommitAttempt([key]);
      beginInFlight([key]);
      try {
        try {
          const result = await commitEnv({ [key]: null });
          if (result.kind !== 'ok') {
            const detail = localizeCommitError(result.errors[0], tShell);
            toast({
              msg: tActions('reset_error_toast', { message: detail }),
              kind: 'danger',
            });
            return { kind: 'reset-failed', reason: 'errors', message: detail };
          }
          updatedItems = result.updatedItems;
          pendingRestartKeysFromCommit = result.pendingRestartKeys;
        } catch (err) {
          rethrowNextErrors(err);
          console.error('[settings] resetEnvKeyAndRestart commitEnv failed', err);
          toast({ msg: tActions('reset_network_error_toast'), kind: 'danger' });
          return { kind: 'reset-failed', reason: 'network' };
        }
        // No firstSave.trigger() here: the caller (account.tsx pwd reset modal)
        // owns the explanatory UX for what just happened and what's coming
        // next. Stacking the global first-save modal on top of the active
        // reset modal would show two backdrops and obscure the restart
        // progress — the inline reset modal already carries equivalent
        // "writes land in the DB" context for users who haven't seen any
        // commits yet. If another bypass caller is added later that lacks
        // its own explanatory modal, it should fire firstSave at the call
        // site, NOT here.
        setStore((s) => {
          const nextEnv = new Map(s.env);
          for (const item of updatedItems) {
            nextEnv.set(item.key as ManagedEnvKey, item);
          }
          return {
            ...s,
            env: nextEnv,
            dirty: omitKeys(s.dirty, [key]),
          };
        });
      } finally {
        // Release in-flight as soon as the reset has persisted (or failed),
        // BEFORE performRestart — the restart's own window.location.reload()
        // must not trip the unsaved-edit beforeunload guard (see the note at
        // the top of this helper). Balanced with the beginInFlight above on
        // every exit path of the commit phase (errors-return, network-catch
        // return, and normal completion).
        endInFlight([key]);
      }
      // From here we are NOT in-flight: with hasInFlight back to false (and no
      // dirty / editing state), the beforeunload guard's effect early-returns,
      // so performRestart's reload proceeds without a spurious leave prompt.
      // Reset persisted; about to POST /server/restart. The caller flips its
      // progress UI to "restarting…" here so the user sees the transition
      // before performRestart blocks on the supervisor estimate.
      onPhase?.('restart-requested');
      const r = await performRestart(() => {
        // serverRestart() returned, polling /health begins.
        onPhase?.('restart-polling');
      });
      if (r.ok) return { kind: 'success' };
      // Restart failed: the reset persisted server-side and the password
      // key now needs a restart to take effect. Wire it into the shell's
      // restartPromptKeys so the user has a recovery path (sticky
      // pending-restart banner + "Restart now" CTA) once their custom
      // error modal is dismissed. Without this, the caller's modal closes
      // with the user stranded — server thinks restart is still pending,
      // but no UI path remains to retry.
      reconcileRestartKeys([key], pendingRestartKeysFromCommit, { openModal: false });
      if (r.reason === 'timeout') {
        return { kind: 'restart-failed', reason: 'timeout' };
      }
      // post_failed: server actively refused the restart POST. No
      // useful detail is available from the unified helper (it only
      // distinguishes ok vs non-ok response, not body content);
      // account.tsx's caller falls back to the generic
      // `restart_error_unknown` copy when message is omitted.
      return { kind: 'restart-failed', reason: 'failed' };
    },
    [
      toast,
      tActions,
      performRestart,
      reconcileRestartKeys,
      beginInFlight,
      endInFlight,
      beginCommitAttempt,
      tShell,
    ],
  );

  const requestNavigate = useCallback(
    (next: SettingsGroupId, options?: NavigateOptions) => {
      if (options?.llmTab !== undefined) {
        setLlmInitialTab(options.llmTab);
      }
      // Use hasNavBlocker (legacy dirty + per-field in-flight + per-field
      // editing) so auto-commit pilots and inline edit forms get the same
      // leave-modal treatment as the SaveBar path.
      if (hasNavBlocker) {
        setPendingNav(next);
        setPendingNavOptions(options ?? null);
        setPendingNavRollbackUrl(
          currentLocationGroup() === next && next !== group ? currentHrefForGroup(group) : null,
        );
      } else {
        setGroup(next);
        setMobileNavOpen(false);
        setPendingNavRollbackUrl(null);
      }
    },
    [group, hasNavBlocker],
  );
  // Sync mirror to the ref declared above the URL effect, so deep-link sync
  // calls always see the latest closure (with current hasNavBlocker).
  requestNavigateRef.current = requestNavigate;

  const confirmDiscardAndNavigate = useCallback(() => {
    setStore((s) => ({ ...s, dirty: omitKeys(s.dirty, groupKeys) }));
    if (pendingNav) {
      setGroup(pendingNav);
      setMobileNavOpen(false);
    }
    if (pendingNavOptions?.llmTab !== undefined) {
      setLlmInitialTab(pendingNavOptions.llmTab);
    }
    setPendingNav(null);
    setPendingNavOptions(null);
    setPendingNavRollbackUrl(null);
  }, [groupKeys, pendingNav, pendingNavOptions]);

  const cancelPendingNavigate = useCallback(() => {
    if (pendingNavRollbackUrl !== null && typeof window !== 'undefined') {
      window.history.replaceState(null, '', pendingNavRollbackUrl);
    }
    setPendingNav(null);
    setPendingNavOptions(null);
    setPendingNavRollbackUrl(null);
  }, [pendingNavRollbackUrl]);

  // Auto-clear LLM tab hint once the user leaves the LLM group, so re-entering
  // it later (without a fresh hint) lands on the default 'providers' tab
  // instead of resurrecting the previous deep-link target.
  useEffect(() => {
    if (group !== 'llm' && llmInitialTab !== undefined) {
      setLlmInitialTab(undefined);
    }
  }, [group, llmInitialTab]);

  // beforeunload guard whenever ANY group has unsaved dirty.
  // Known gap: this only fires on full page unload. Next.js client-side
  // navigation (TopNav links, sidebar links rendered as `next/link`,
  // browser back into a Next route) does NOT trigger `beforeunload`, so
  // dirty edits silently disappear when the user clicks away within the
  // SPA. Only intra-settings group switching is protected (via
  // `requestNavigate` + leave-modal). A full router-level guard requires
  // hooking `next/navigation`'s push/replace; tracked as a follow-up.
  useEffect(() => {
    // Cover the same three buckets as `hasNavBlocker` — legacy dirty,
    // per-field in-flight commit, per-field editing draft. Without
    // in-flight / editing checks, closing the tab during an auto-save
    // would silently drop the request without prompting.
    if (!hasAnyDirty && !hasInFlight && !hasEditing) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // `returnValue = ''` is deprecated per the modern HTML spec (preventDefault
      // alone is sufficient in current browsers), but Safari and older Chromium
      // still require it to surface the leave-confirmation prompt. The TS
      // deprecation marker is a hint (★), not an error — keep both writes
      // until the supported browser matrix drops the legacy path.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [hasAnyDirty, hasInFlight, hasEditing]);

  // Per-group dirty for sidebar dot — notify 走动态 notifyKeys（包括 manifest
  // 派生的 plugin envKeys），llm 走动态 llmKeys（包含 GOLDPAN_LLM_PROVIDER_<ID>_*
  // pattern 派生），其它走 GROUP_ENV_KEYS 的静态白名单。
  const dirtyByGroup = useMemo(() => {
    const r: Record<SettingsGroupId, boolean> = {} as Record<SettingsGroupId, boolean>;
    for (const gid of Object.keys(GROUP_ENV_KEYS) as SettingsGroupId[]) {
      const keys: ReadonlyArray<string> =
        gid === 'notify'
          ? notifyKeys
          : gid === 'llm'
            ? llmKeys
            : gid === 'search'
              ? searchKeys
              : gid === 'digest'
                ? digestKeys
                : GROUP_ENV_KEYS[gid];
      r[gid] = keys.some((k) => k in store.dirty);
    }
    return r;
  }, [store.dirty, notifyKeys, llmKeys, searchKeys, digestKeys]);

  // Plugins group is read-only (snapshot of PluginRegistry, no env writes flow
  // through it), so its dirty flag never lights up; the legacy
  // `dirtyPluginCount` badge from the old mock-driven implementation is
  // intentionally not carried over.
  const badges: Record<string, 'restart' | 'off' | 'dirty' | null> = useMemo(() => {
    const out: Record<string, 'restart' | 'off' | 'dirty' | null> = {
      digest: !store.digestEnabled ? 'off' : null,
    };
    for (const gid of Object.keys(dirtyByGroup) as SettingsGroupId[]) {
      if (gid === 'digest') continue;
      if (dirtyByGroup[gid]) out[gid] = 'dirty';
    }
    return out;
  }, [store.digestEnabled, dirtyByGroup]);

  // Group-prop helper: shape unchanged from old `update` for groups that
  // still rely on mock state. New env-backed groups receive `env / dirty /
  // patch / reset / save / mock` directly via destructured props.
  const groupProps = {
    env: store.env,
    dirty: store.dirty,
    patch,
    applyEnvItems,
    reset,
    resetEnvKey,
    resetEnvKeyAndRestart,
    save,
    commit, // NEW — per-field auto-commit pipeline for migrated groups
    // Set of env keys with at least one commit currently in flight. Used by
    // group children (IM action buttons, plugin contribution action buttons)
    // to disable the action while a save is mid-air — otherwise a user who
    // edits a token + clicks Test in the same tick fires the action against
    // the OLD env, then the commit lands a moment later. See ImChannelCard
    // and PluginActionButton for the actual disable wiring.
    inFlightKeys,
    mock: store.mock,
    updateMock,
    toast,
    navigateToGroup: requestNavigate,
    setFieldEditing,
  };

  let body: React.ReactNode;
  switch (group) {
    case 'account':
      body = <GroupAccount {...groupProps} />;
      break;
    case 'data':
      body = <GroupData {...groupProps} />;
      break;
    case 'appearance':
      body = <GroupAppearance {...groupProps} />;
      break;
    case 'llm':
      body = <GroupLLM {...groupProps} initialTab={llmInitialTab} />;
      break;
    case 'embedding':
      body = <GroupEmbedding {...groupProps} />;
      break;
    case 'plugins':
      body = <GroupPlugins {...groupProps} pluginsSnapshot={store.pluginsSnapshot} />;
      break;
    case 'collect':
      body = <GroupCollect {...groupProps} contributions={contributions} />;
      break;
    case 'search':
      body = (
        <GroupSearch
          {...groupProps}
          contributions={contributions}
          contributionsError={contributionsError}
        />
      );
      break;
    case 'notify':
      body = <GroupNotify {...groupProps} manifests={manifests} language={language} />;
      break;
    case 'digest':
      body = (
        <GroupDigest
          {...groupProps}
          contributions={contributions}
          digestEnabled={store.digestEnabled}
          presets={store.presets}
          setPresets={(updater) =>
            setStore((s) => ({
              ...s,
              presets: typeof updater === 'function' ? updater(s.presets) : updater,
            }))
          }
          manifests={manifests}
          language={language}
        />
      );
      break;
    case 'about':
      body = <GroupAbout {...groupProps} />;
      break;
  }

  return (
    <EnvMappingVisibilityProvider visible={envMappingVisibility.visible}>
      <div className={`gp-settings gp-settings--${group}`}>
        <button
          type="button"
          className="gp-settings__mobile-trigger"
          onClick={() => setMobileNavOpen((o) => !o)}
          aria-expanded={mobileNavOpen}
        >
          <span>{GROUP_LABEL[group]}</span>
          <ChevronIcon size={14} />
        </button>
        <nav
          className={`gp-snav${mobileNavOpen ? ' gp-snav--open' : ''}`}
          aria-label={t('nav_label')}
        >
          <div className="gp-snav__header">
            <h2 className="gp-snav__title">{tShell('title')}</h2>
            <div className="gp-snav__actions">
              <span className="gp-snav__tip-host">
                <button
                  type="button"
                  className="gp-btn gp-snav__env-toggle"
                  data-variant={envMappingVisibility.visible ? 'primary' : 'secondary'}
                  data-size="sm"
                  aria-pressed={envMappingVisibility.visible}
                  aria-label={
                    envMappingVisibility.visible
                      ? tActions('env_mapping_toggle_hide')
                      : tActions('env_mapping_toggle_show')
                  }
                  title={tActions('env_mapping_toggle_hint')}
                  onClick={envMappingVisibility.toggle}
                >
                  <Code2 size={14} aria-hidden="true" />
                </button>
                <span className="gp-snav__tip-bubble" aria-hidden="true">
                  {envMappingVisibility.visible
                    ? tActions('env_mapping_toggle_hide')
                    : tActions('env_mapping_toggle_show')}
                  {' · '}
                  {tActions('env_mapping_toggle_hint')}
                </span>
              </span>
              <span className="gp-snav__tip-host">
                <Btn
                  sm
                  kind="secondary"
                  aria-describedby={exportHintId}
                  onClick={handleExportOverrides}
                >
                  {tActions('export')}
                </Btn>
                <span id={exportHintId} className="gp-sr-only">
                  {tActions('export_hint')}
                </span>
                <span className="gp-snav__tip-bubble" aria-hidden="true">
                  {tActions('export_hint')}
                </span>
              </span>
            </div>
          </div>
          <div className="gp-snav__scroll">
            {SECTION_ORDER.map((sect) => (
              <div key={sect}>
                <div className="gp-snav__heading">{SECTION_LABEL[sect]}</div>
                {GROUPS.filter((g) => g.section === sect).map((g) => {
                  const Icon = GROUP_ICONS[g.id];
                  return (
                    <button
                      key={g.id}
                      type="button"
                      className="gp-snav__item"
                      aria-pressed={group === g.id}
                      onClick={() => requestNavigate(g.id)}
                    >
                      <span className="gp-snav__item-icon">
                        <Icon size={14} />
                      </span>
                      <span className="gp-snav__item-label">{GROUP_LABEL[g.id]}</span>
                      {badges[g.id] === 'restart' || badges[g.id] === 'dirty' ? (
                        <span className="gp-snav__item-dot gp-snav__item-dot--warn" />
                      ) : null}
                      {badges[g.id] === 'off' ? <span className="gp-snav__item-dot" /> : null}
                      {g.readonly ? (
                        <span className="gp-snav__item-readonly">{tShell('readonly_badge')}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>
        <main className={`gp-smain${group === 'digest' ? ' gp-smain--wide' : ''}`}>
          {body}
          {/* SaveBar and the pending-restart banner share the sticky-bottom
            slot. Dirty edits take precedence (the user is mid-task — finish
            their flow before nagging about a previous restart obligation);
            once dirty clears, the banner re-appears so dismissing the modal
            with "稍后" isn't a dead-end. They never coexist intentionally. */}
          <SettingsSaveBar
            visible={hasGroupDirty}
            saving={saving}
            onSave={save}
            onUndo={reset}
            saveLabel={tShell('save_button')}
            savingLabel={tShell('saving_button')}
            undoLabel={tShell('undo_button')}
            regionLabel={tShell('save_bar_label')}
          />
          {restartPromptKeys !== null && !restartModalOpen && !hasGroupDirty ? (
            <RestartPendingBanner count={restartPromptKeys.length} onOpen={onRestartReopen} />
          ) : null}
        </main>
        {pendingNav !== null ? (
          <Modal
            heading={tShell('leave_group_modal_heading')}
            desc={tShell('leave_group_modal_desc')}
            closeLabel={t('modal_close')}
            confirmLabel={tShell('leave_group_modal_confirm')}
            cancelLabel={tShell('leave_group_modal_cancel')}
            onClose={cancelPendingNavigate}
            onConfirm={confirmDiscardAndNavigate}
          />
        ) : null}
        {/* First-save dialog and the pending-restart prompt are independent, but
          stacking two `Modal` backdrops on top of each other looks busy in this
          UI. Gate the restart prompt on `firstSave.show === false` so the user
          sees the "saves go to DB" notice first, dismisses it, and *then* sees
          the restart prompt — both surface from the same `kind: 'ok'` commit.
          Single-button modal: omit `onConfirm` to suppress the default 2-button
          footer and render a "Got it" button inline via children, matching the
          RestartPrompt pattern for custom footers. */}
        {firstSave.show ? (
          <Modal
            heading={tFirstSave('title')}
            desc={tFirstSave('body')}
            closeLabel={t('modal_close')}
            onClose={firstSave.dismiss}
          >
            <div className="gp-first-save__actions">
              <Btn sm kind="primary" onClick={firstSave.dismiss}>
                {tFirstSave('got_it')}
              </Btn>
            </div>
          </Modal>
        ) : null}
        {restartPromptKeys !== null && restartModalOpen && !firstSave.show ? (
          <RestartPrompt
            keys={restartPromptKeys}
            onConfirm={onRestartConfirm}
            onCancel={onRestartCancel}
            inProgress={restarting}
          />
        ) : null}
        <ToastStack toasts={toasts} dismiss={api.dismiss} closeLabel={tShell('toast_close')} />
      </div>
    </EnvMappingVisibilityProvider>
  );
}

// ─── Group prop type re-exported for groups to consume ─────────────────────

/** Sub-target hints carried alongside `navigateToGroup`. Each field is opt-in
 * and only meaningful when the target group recognizes it (currently only
 * `llmTab` consumed by GroupLLM). Add new fields here when introducing fresh
 * deep-link affordances instead of widening callsites with positional args. */
export interface NavigateOptions {
  /** When navigating to `'llm'`, pick which tab to mount on. Consumed once,
   * then cleared when the user leaves the LLM group. */
  llmTab?: LlmSettingsTab;
}

/** GroupLLM exports this as its own internal state type, but we duplicate the
 * union here to avoid an awkward import cycle (shell → llm group → shell). */
export type LlmSettingsTab = 'pipeline' | 'providers';

export type GroupProps = {
  env: ReadonlyMap<string, EnvKeyState>;
  dirty: Readonly<Record<string, string>>;
  patch: (key: string, value: string) => void;
  /** Apply freshly returned post-commit env rows from direct commit modals. */
  applyEnvItems: (items: EnvKeyState[]) => void;
  /** Discard all pending dirty edits for the current group (group-level undo). */
  reset: () => void;
  /** Per-key revert: delete the runtime override and refresh the row state.
   * Use this for the inline "Reset" button next to a single env key when its
   * `source === 'override'`. Independent from `dirty` / `save` flow.
   * Returns `true` on successful persist, `false` when the server rejected
   * or the network failed (caller is responsible for not chaining
   * success-path side-effects in that case). */
  resetEnvKey: (key: string) => Promise<boolean>;
  /** One-shot "reset env key + immediately restart server" used by callers
   * that already drive their own confirm dialog (e.g. account.tsx login
   * password reset). Skips the standard RestartPrompt — the caller's modal
   * is responsible for explaining the restart. On `kind: 'success'` the
   * page is about to reload via `window.location.reload()`; on the failure
   * variants the caller is responsible for surfacing the message in its
   * own progress UI (the shell already toasts the reset-side error).
   *
   * `onPhase` fires twice: once when the reset has persisted and we're
   * about to POST /server/restart (`'restart-requested'`), then once more
   * when serverRestart() returns and /health polling begins
   * (`'restart-polling'`). Callers use this to advance their progress UI
   * from "resetting…" → "restarting…" → "polling for server" without
   * re-implementing the underlying lifecycle.
   *
   * **Single-callsite caveat**: as of this writing the only production
   * consumer is account.tsx's password reset confirm modal. The helper
   * lives on GroupProps (not in account.tsx as a local function) because
   * the reset → restart sequence needs the shell-level commit pipeline
   * (firstSave trigger, env-state merge, sanitised toast) and the
   * shared `performRestart` poll. If another destructive-reset-with-
   * restart use case shows up (e.g. clearing the DB-encryption key) it
   * can reuse this without duplication; if it stays solo for too long,
   * inline it back into account.tsx. */
  resetEnvKeyAndRestart: (
    key: string,
    onPhase?: (phase: 'restart-requested' | 'restart-polling') => void,
  ) => Promise<
    | { kind: 'reset-failed'; reason: 'errors' | 'network'; message?: string }
    | { kind: 'restart-failed'; reason: 'timeout' | 'failed'; message?: string }
    | { kind: 'success' }
  >;
  save: () => Promise<void>;
  /** Single-key commit helper for the new auto-commit field pattern.
   * Wraps commitEnv with the same shell-level housekeeping (pendingRestart
   * merge, firstSave trigger, env-state update) but driven per-field
   * instead of via dirty store. Used by migrated groups; legacy groups
   * keep using `patch` + `save`. */
  commit: (
    patch: Record<string, string | null>,
  ) => Promise<import('@goldpan/web-sdk').CommitEnvResult>;
  /** Env keys that currently have at least one in-flight commit. Consumers
   * use `inFlightKeys.has(envKey)` to disable side-effecting buttons (e.g.
   * IM channel Test, plugin contribution Test) until the write is settled —
   * acting before settle reads stale `process.env` on the server. */
  inFlightKeys: ReadonlySet<string>;
  mock: SettingsMockSlice;
  updateMock: (mut: (m: SettingsMockSlice) => Partial<SettingsMockSlice>) => void;
  toast: (t: import('@/components/toast-stack').ToastInput) => void;
  /** SPA group navigation. Use for in-content "go to <group>" affordances
   * (e.g. plugin row "Configure" button) instead of `<a href="?group=...">`,
   * which would full-reload the page and re-fetch all server-side props.
   *
   * `options` carries sub-target hints (e.g. which LLM tab to open). The shell
   * stores the hint, threads it into the matching group via prop, and clears
   * it when the user leaves the target group — callers do not need to clean up. */
  navigateToGroup: (group: SettingsGroupId, options?: NavigateOptions) => void;
  /** Tell the shell that this group has an unsaved local draft for `envKey`
   * (e.g. an open password edit form, or an inline edit text input with
   * uncommitted typing). The shell merges these per-field editing markers
   * with `store.dirty` + in-flight commits into the leave/unload guard.
   * Call with `false` on unmount / when the draft is committed or
   * discarded — leaving a stale `true` would block all future navigation. */
  setFieldEditing: (envKey: string, editing: boolean) => void;
};
