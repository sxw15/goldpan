import type { ILogObj, Logger } from 'tslog';
import type { DrizzleDB } from '../db/connection';
import { SqliteRuntimeConfigOverrideRepository } from '../db/repositories/runtime-config';
import {
  extractDynamicAllowedEnvNames,
  isManagedEnvKey,
  MANAGED_ENV_KEYS,
} from '../onboarding/env-file';
import { loadConfig } from './index';
import type {
  CommitOptions,
  CommitResult,
  ConfigOrigin,
  ConfigPatch,
  ConfigSnapshot,
  ConfigStore,
  SnapshotListener,
} from './store-types';
import { stripNulls, validateStaged } from './validate-staged';

export interface CreateConfigStoreOptions {
  db: DrizzleDB;
  /** Frozen process.env snapshot taken in apps/server/main.ts after dotenv.config. */
  bootEnv: Readonly<NodeJS.ProcessEnv>;
  /** Default true; tests pass false to keep process.env clean. */
  applyToProcessEnv?: boolean;
  /** Plugin envSpec keys joined into the override whitelist. */
  pluginEnvKeys?: ReadonlyArray<string>;
  logger: Logger<ILogObj>;
}

/**
 * Compute the merged process.env-shaped record from baseline ⊕ DB override.
 * Only managed keys are considered — non-managed keys (PATH / NODE_OPTIONS)
 * stay as-is on the bootEnv copy.
 */
function mergeEnv(
  bootEnv: Readonly<NodeJS.ProcessEnv>,
  overrides: ReadonlyMap<string, string>,
  allKeys: ReadonlyArray<string>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...bootEnv };
  for (const key of allKeys) {
    if (overrides.has(key)) {
      merged[key] = overrides.get(key);
    }
  }
  return merged;
}

function computeOrigins(
  bootEnv: Readonly<NodeJS.ProcessEnv>,
  overrides: ReadonlyMap<string, string>,
  allKeys: ReadonlyArray<string>,
): Map<string, ConfigOrigin> {
  const origins = new Map<string, ConfigOrigin>();
  for (const key of allKeys) {
    if (overrides.has(key)) origins.set(key, 'override');
    else if (typeof bootEnv[key] === 'string' && bootEnv[key] !== '') origins.set(key, 'env');
    else origins.set(key, 'default');
  }
  return origins;
}

export async function createConfigStore(opts: CreateConfigStoreOptions): Promise<ConfigStore> {
  const { db, bootEnv, applyToProcessEnv = true, logger } = opts;
  const repo = new SqliteRuntimeConfigOverrideRepository(db);

  // Mutable through `setPluginEnvKeys()` — bootstrap creates the store BEFORE
  // plugin discovery completes (composeIMRuntime wires up channel manifests
  // after this call). The composition layer calls `setPluginEnvKeys` once it
  // has the complete list, so subsequent `commit` calls accept plugin-managed
  // keys against the up-to-date whitelist.
  let pluginEnvKeys: ReadonlyArray<string> = opts.pluginEnvKeys ?? [];

  // Whitelist universe — seeded at construction, grown by `setPluginEnvKeys`
  // and by per-commit dynamic-key admission (custom LLM provider declarations).
  const knownKeys: string[] = [...MANAGED_ENV_KEYS, ...pluginEnvKeys];
  const allKeysSet = new Set<string>(knownKeys);
  // Pull DB-only dynamic keys (e.g. GOLDPAN_LLM_PROVIDER_X_BASE_URL saved in
  // a previous session) — they need to be in origins so the UI can display
  // them. Pattern check via isManagedEnvKey, plus the patch-scoped dynamic
  // allowlist (extracted from any saved `*_API_KEY_ENV` declarations) so the
  // user-chosen secret env var name (e.g. `TOGETHER_API_KEY`) is also
  // recognized — otherwise the secret persists to DB but never propagates to
  // process.env on subsequent snapshot rebuilds.
  const dbOverrides = repo.list();
  const initialDynamicAllowList = extractDynamicAllowedEnvNames(dbOverrides);
  for (const k of dbOverrides.keys()) {
    if (isManagedEnvKey(k, pluginEnvKeys, initialDynamicAllowList)) allKeysSet.add(k);
  }
  // Mutable through .push() in commit() — when the user persists a brand-new
  // managed key mid-session (e.g. declaring a custom LLM provider, whose
  // dynamic GOLDPAN_LLM_PROVIDER_<ID>_* keys didn't exist at construction
  // time), commit appends it so origins / merge see it in subsequent snapshots.
  // Biome's useConst correctly flags `const` here since only the contents
  // change, not the binding — closures capture the same array reference.
  const allKeys = [...allKeysSet];

  // commit() bumps generation per commit so SnapshotListeners (e.g. LlmRegistry
  // cache key) can detect change cheaply.
  let generation = 0;

  function buildSnapshot(overrides: ReadonlyMap<string, string>): ConfigSnapshot {
    const merged = mergeEnv(bootEnv, overrides, allKeys);
    const config = loadConfig(merged);
    const origins = computeOrigins(bootEnv, overrides, allKeys);
    return { config, origins, generation };
  }

  function applyMergedToProcessEnv(merged: NodeJS.ProcessEnv): void {
    if (!applyToProcessEnv) return;
    // Only touch managed keys. Setting / deleting non-managed env (PATH etc.)
    // would be a footgun — see spec "Merge 算法" note.
    for (const key of allKeys) {
      const v = merged[key];
      if (typeof v === 'string') {
        process.env[key] = v;
      } else {
        delete process.env[key];
      }
    }
  }

  let snapshot = buildSnapshot(dbOverrides);
  applyMergedToProcessEnv(mergeEnv(bootEnv, dbOverrides, allKeys));

  const listeners = new Set<SnapshotListener>();

  function getSnapshot(): ConfigSnapshot {
    return snapshot;
  }

  // Single-flight write lock — serializes concurrent commit() calls so
  // validation / DB write / process.env apply / snapshot rebuild always run
  // as one atomic unit per call. Each ConfigStore has its own lock (per-store
  // closure) so multiple stores in tests don't share state.
  let writeChain: Promise<unknown> = Promise.resolve();

  async function withCommitLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = writeChain;
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    writeChain = previous.then(() => next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async function commit(patch: ConfigPatch, options?: CommitOptions): Promise<CommitResult> {
    return withCommitLock(async () => {
      const currentOverrides = repo.list();
      const result = validateStaged({
        patch,
        bootEnv,
        currentOverrides,
        pluginEnvKeys,
        pluginEnvSchemas: options?.pluginEnvSchemas,
        knownLlmProviderIds: options?.knownLlmProviderIds,
      });
      if (!result.ok) return { kind: 'errors', errors: result.errors };

      // (validateStagedBaseUrls SSRF check is wired at the route layer — Task 14
      // for settings, Task 16 for wizard. ConfigStore.commit stays SSRF-agnostic
      // so future programmatic callers / tests can skip the resolver overhead.
      // Both Task 14 and Task 16 MUST call SSRF before reaching this function —
      // removing either is a security regression.)

      repo.applyPatch(patch);
      const newOverrides = repo.list();

      // Grow allKeys for any brand-new managed key persisted (so origins /
      // merge see them in this and subsequent snapshots). The whitelist check
      // here mirrors `validateStaged` — including the patch-scoped
      // `dynamicAllowList` from `extractDynamicAllowedEnvNames(patch)` — so a
      // user-chosen secret env var (e.g. `TOGETHER_API_KEY` declared via
      // `GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV`) gets folded in alongside
      // the BASE_URL / API_KEY_ENV pair. Without this the secret would persist
      // to DB but never propagate to `process.env`, breaking
      // `parseCustomLlmProviders` mid-session until the next restart layers it
      // back into bootEnv.
      const dynamicAllowList = extractDynamicAllowedEnvNames(stripNulls(patch));
      for (const k of newOverrides.keys()) {
        if (!allKeysSet.has(k) && isManagedEnvKey(k, pluginEnvKeys, dynamicAllowList)) {
          allKeysSet.add(k);
          allKeys.push(k);
        }
      }

      const merged = mergeEnv(bootEnv, newOverrides, allKeys);
      applyMergedToProcessEnv(merged);

      const prevSnap = snapshot;
      generation += 1;
      snapshot = buildSnapshot(newOverrides);
      const newSnap = snapshot;

      // Promise.allSettled — listener throwing logs warn but does NOT abort
      // other listeners or fail the commit. Promise.all would short-circuit on
      // first rejection.
      const settled = await Promise.allSettled(
        [...listeners].map(async (l) => l(newSnap, prevSnap)),
      );
      for (const r of settled) {
        if (r.status === 'rejected') {
          logger.warn('ConfigStore onChange listener threw', {
            err: r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        }
      }

      return { kind: 'ok', snapshot: newSnap };
    });
  }

  function onChange(listener: SnapshotListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function refresh(): Promise<ConfigSnapshot> {
    const overrides = repo.list();
    const newSnap = buildSnapshot(overrides);
    snapshot = newSnap;
    applyMergedToProcessEnv(mergeEnv(bootEnv, overrides, allKeys));
    return newSnap;
  }

  function setPluginEnvKeys(keys: ReadonlyArray<string>): void {
    // Semantics: `pluginEnvKeys` is REPLACED with `keys` (后续 commit 走的
    // whitelist 跟着翻新)，`allKeys` 是 append-only（已经放进去的 key 不会被
    // 再次踢出，避免现存 snapshot / origins 突然丢列）。生产 main.ts 只调一
    // 次，这两种语义差异不会触发 bug；测试或将来 hot-reload plugin 重新计
    // 算 envKeys 时要明白：撤回的 plugin key 还会留在 `allKeys` 里。
    //
    // 时序约束：composition 层在 bootstrap 返回之后调用本 setter
    // (apps/server/src/main.ts:344)，**plugin init 阶段读不到这里新增 key 的
    // DB override**：bootstrap 内部 `pluginRegistry.initializeAll` 已经跑完，
    // 任何在 init 里读 `process.env.X` 的 plugin（X 不在 MANAGED_ENV_KEYS
    // literal 里）都只能看到 bootEnv 值。要让某个 plugin envKey 在 init 时
    // 读到 DB override，**必须把它写进 onboarding/env-file.ts MANAGED_ENV_KEYS
    // literal**（store 构造时就会承认它）。当前所有 IM channel keys 都满足
    // 这条约束。本 setter 只解决“post-init commit 路径需要承认 plugin keys”
    // 这一窄场景。
    pluginEnvKeys = [...keys];
    let added = false;
    for (const k of keys) {
      if (!allKeysSet.has(k)) {
        allKeysSet.add(k);
        allKeys.push(k);
        added = true;
      }
    }
    if (!added) return;
    // A pre-existing DB override for one of the newly-whitelisted keys was
    // skipped at construction (the key wasn't in `allKeys` then). Reapply now
    // so process.env / snapshot pick it up. We do NOT bump `generation` here —
    // listeners that fire on commit don't need to fire on this one-time wiring;
    // the next real commit will pick up the new keys naturally.
    const overrides = repo.list();
    applyMergedToProcessEnv(mergeEnv(bootEnv, overrides, allKeys));
    snapshot = buildSnapshot(overrides);
  }

  return { getSnapshot, commit, onChange, refresh, setPluginEnvKeys };
}
