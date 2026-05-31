import type { ZodRawShape } from 'zod';
import type { GoldpanConfig } from './index';

export type ConfigOrigin = 'env' | 'override' | 'default';

export interface ConfigSnapshot {
  /** loadConfig() of (BOOT_ENV_SNAPSHOT ⊕ DB override) — readonly. */
  readonly config: GoldpanConfig;
  /**
   * Per-key origin. Domain = MANAGED_ENV_KEYS ∪ MANAGED_ENV_PATTERNS-matched
   * keys present in DB ∪ pluginEnvKeys passed at construction. Keys outside
   * this domain are absent from the map (NOT mapped to 'default').
   */
  readonly origins: ReadonlyMap<string, ConfigOrigin>;
  /** Monotonically increasing per commit. Used by LlmRegistry cache key. */
  readonly generation: number;
}

/** null value = delete this override (revert to baseline / default). */
export type ConfigPatch = ReadonlyMap<string, string | null>;

export interface CommitOptions {
  /**
   * Plugin envSchema shapes — merged into a single `z.object({...})` and run
   * against the staged record before the DB write so plugin-managed keys
   * (e.g. GOLDPAN_IM_FEISHU_DOMAIN) are validated by the plugin's own zod
   * schema, not just by the next boot.
   */
  pluginEnvSchemas?: ReadonlyArray<ZodRawShape>;
  /**
   * LLM provider ids registered by plugins. Core can validate builtin and
   * custom OpenAI-compatible providers from env alone, but plugin provider ids
   * live in PluginRegistry and must be threaded in by the server route.
   */
  knownLlmProviderIds?: ReadonlyArray<string>;
}

export type CommitResult =
  | { kind: 'ok'; snapshot: ConfigSnapshot }
  | { kind: 'errors'; errors: { path: string; message: string; code?: string }[] };

/**
 * Wizard 路径的 commit 返回类型 — 不带 snapshot。原因:
 *  1. spec 明确说"wizard 不创建 ConfigStore"(snapshot 需要 strict GoldpanConfig,
 *     wizard 阶段配置不全 → strict loadConfig 必抛)。
 *  2. wizard caller (POST /onboarding/commit handler) 写完立即 restart,根本
 *     不读 snapshot — 强行造一个 snapshot 是 dead code,还会在 strict-load
 *     失败时把整个 commit 流程拖崩。
 *  3. 类型独立于 CommitResult,避免给 ConfigStore.commit 的调用方一个永远
 *     undefined 的 optional snapshot 字段(narrowing 噪音)。
 */
export type WizardCommitResult =
  | { kind: 'ok' }
  | { kind: 'errors'; errors: { path: string; message: string }[] };

export type SnapshotListener = (snap: ConfigSnapshot, prev: ConfigSnapshot) => void;

export interface ConfigStore {
  getSnapshot(): ConfigSnapshot;
  commit(patch: ConfigPatch, options?: CommitOptions): Promise<CommitResult>;
  /**
   * Listeners run in parallel via Promise.allSettled — a single listener
   * throwing logs warn but does NOT abort other listeners or fail the commit.
   */
  onChange(listener: SnapshotListener): () => void;
  /** Force re-merge from DB. Normally not needed (commit triggers itself). */
  refresh(): Promise<ConfigSnapshot>;
  /**
   * Append plugin envSchema keys into the override whitelist after construction.
   *
   * `bootstrap()` creates `ConfigStore` BEFORE plugin discovery completes (the
   * plugin registry / IM bundles are wired up afterwards), so plugin-managed
   * env keys can't be passed via `pluginEnvKeys` at construction. The composition
   * layer (apps/server/main.ts) calls this once after `composeIMRuntime` to
   * register every channel's `enable.envKey` + `fields[].envKey`. Without this
   * call, `commit` rejects plugin-managed keys ("not in managed override
   * whitelist") and the bootstrap merge skips DB-saved plugin overrides whose
   * keys aren't already hardcoded in core's `MANAGED_ENV_KEYS`.
   *
   * Append-only: keys are added to the existing whitelist, never removed.
   * Subsequent `commit` / `getSnapshot` calls reflect the new keys; this also
   * reapplies the merged env to `process.env` so any DB override that was
   * previously skipped (because its key wasn't whitelisted yet) takes effect now.
   */
  setPluginEnvKeys(keys: ReadonlyArray<string>): void;
}
