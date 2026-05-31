// apps/server/src/routes/settings.ts
import { type ConfigStore, isStaticRestartRequiredKey, stripNulls } from '@goldpan/core/config';
import type { RuntimeConfigOverrideRepository } from '@goldpan/core/db/repositories';
import { MANAGED_ENV_KEYS } from '@goldpan/core/onboarding';
import type { ZodRawShape } from 'zod';
import { isTransientDnsError, validateStagedBaseUrls } from '../lib/base-url-security.js';
import { parseJsonBody, type RouteContext, respond, respondError } from './types.js';

export interface SettingsRouteDeps {
  /**
   * Single source of truth for runtime configuration. POST /settings/env
   * routes the patch through `configStore.commit` (DB write + process.env
   * apply + listener notify); GET /settings/env-state derives row state
   * from `configStore.getSnapshot().origins`.
   */
  configStore: ConfigStore;
  /**
   * Frozen `process.env` snapshot taken in `apps/server/main.ts` after
   * `dotenv.config()`. Used by `buildEnvState` to compute `baselineDiffers`:
   * an override row whose value differs from the bootEnv baseline shows a
   * "your .env still defines a different value" hint in the UI.
   */
  bootEnv: Readonly<NodeJS.ProcessEnv>;
  /**
   * Boot-EFFECTIVE env baseline for the restart-pending comparison: `.env`
   * with the DB runtime overrides applied on top, as they stood when THIS
   * server process booted (what its own boot-frozen readers — e.g.
   * `handle.config` — actually loaded; the separate web process keeps its own
   * frozen state this can't model, so dual-process keys still lean on
   * DUAL_PROCESS_RESTART_KEYS to prompt a web restart too). A restart-required
   * key counts as "pending"
   * only when its post-commit value differs from THIS, so reverting to the
   * value already running resolves the restart — even for a key absent from
   * `.env` but set via a DB override (the common self-deploy case, which
   * compared against an empty `.env` baseline and could never resolve).
   * Kept SEPARATE from `bootEnv` (pre-merge `.env`), which stays the baseline
   * for the origin / baselineDiffers UI hints — folding the two would make a
   * DB-only override read as `source: 'env'`. Defaults to `bootEnv` when
   * unset (callers / tests with no separate boot-merge step → pre-fix
   * behaviour, so existing restart tests keep passing unchanged).
   */
  bootEffectiveEnv?: Readonly<NodeJS.ProcessEnv>;
  /**
   * Repo for the raw DB-persisted runtime config overrides. Used by
   * `GET /settings/export-overrides` to dump only the override rows (no
   * baseline / default merging). Going through ConfigStore would also
   * surface keys whose value coincides with baseline — for export we want
   * exactly the DB-persisted patch.
   */
  runtimeConfigOverrideRepo: RuntimeConfigOverrideRepository;
  /**
   * Additional managed env keys contributed by IM plugin manifests. These get
   * folded into the env-state listing so the settings UI can read / write
   * plugin-owned keys (e.g. GOLDPAN_IM_FEISHU_DOMAIN) without core knowing
   * about them.
   *
   * Empty / omitted is fine — the route degrades to "core keys only", matching
   * pre-PR-44 behaviour.
   */
  pluginEnvKeys?: ReadonlyArray<string>;
  /**
   * Plugin envSpec.envSchema shapes — passed through to `configStore.commit`
   * so staged plugin-managed values get strictly validated against the
   * plugin's zod schema before the DB write. Without this, the next boot's
   * `loadImChannelConfigs` would be the first thing that catches a bad value.
   */
  pluginEnvSchemas?: ReadonlyArray<ZodRawShape>;
  /**
   * LLM provider ids contributed by plugins. Settings model assignment writes
   * are validated before persistence; builtin/custom providers are known to
   * core, while plugin ids must be supplied by the server composition layer.
   */
  knownLlmProviderIds?: ReadonlyArray<string>;
  /**
   * Called after a successful commit with restart-required keys whose
   * post-commit effective value **diverges** from the boot-effective baseline
   * (`.env` + the DB overrides applied at boot) — those genuinely require a
   * process restart to take effect. Caller
   * (`apps/server/main.ts`) adds these into a process-lifetime Set so
   * `/health` can report "the user committed boot-only keys still pending".
   *
   * Optional — wizard-mode and tests don't need to track this.
   */
  onPendingRestart?: (keys: string[]) => void;
  /**
   * Called after a successful commit with restart-required keys that the
   * commit moved **back to the boot-effective baseline** — i.e. back to the
   * value the running process already loaded at boot (user reset an override,
   * or re-typed the value that was already live). Caller removes these from
   * the process-lifetime Set so `/health` stops reporting them — boot-frozen
   * readers already have the right value.
   *
   * Required to fix the "reset still pending forever" bug: without this,
   * pendingRestartKeys only ever grows, even when the user reverts.
   */
  onResolveRestart?: (keys: string[]) => void;
}

// Treat any managed key whose name ends with KEY / TOKEN / SECRET / PASSWORD
// as a secret. Suffix-anchored so a hypothetical `GOLDPAN_LLM_TOKEN_LIMIT`
// would NOT be misclassified as a secret, while real entries like
// `OPENAI_API_KEY` / `GOLDPAN_AUTH_PASSWORD` / `GOLDPAN_IM_TELEGRAM_BOT_TOKEN`
// match correctly.
const SECRET_SUFFIX_RE = /(?:KEY|TOKEN|SECRET|PASSWORD)$/;

function isSecret(key: string): boolean {
  return SECRET_SUFFIX_RE.test(key);
}

// Show only the last 4 chars (industry-standard "is this set / which one"
// affordance — Stripe, AWS, GitHub all do this). Leading bytes are often
// constant prefixes (`sk-` for OpenAI, `xoxb-` for Slack) that leak more
// than they reveal. Threshold `< 13` keeps the leak ratio strictly under
// 1/3 (4/13 ≈ 30.7%); at 12 chars exactly the ratio hits 4/12 = 33% which
// we treat as too generous, so values shorter than 13 fall back to full
// bullets.
function maskSecret(value: string): string {
  if (value.length < 13) return '••••';
  return `••••${value.slice(-4)}`;
}

// Some MANAGED_ENV_KEYS hold URLs (`OPENAI_BASE_URL`, `DEEPSEEK_BASE_URL`,
// `OLLAMA_BASE_URL`, IM url templates). Users occasionally embed credentials
// in the URL form `https://user:pass@host/v1`; returning that plaintext to
// the browser would leak them through the settings UI. Strip userinfo before
// returning. Non-URL strings round-trip unchanged.
function stripUrlCredentials(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (!url.username && !url.password) return value;
  url.username = '';
  url.password = '';
  return url.toString();
}

function escapeSingleQuotedShellValue(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeDoubleQuotedEnvValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Quote a value the way bash + dotenv expect. Empty string passes through.
 * Values containing `$` or backticks use single quotes so shell / compose-style
 * interpolation cannot rewrite secrets; other ambiguous values use a
 * double-quoted form with backslash and double-quote escaped.
 */
function escapeEnvValue(value: string): string {
  if (value === '') return '';
  if (!/[\s#=`"'\\$]/.test(value)) return value;
  if (/[$`]/.test(value)) return escapeSingleQuotedShellValue(value);
  return escapeDoubleQuotedEnvValue(value);
}

/**
 * Render the DB override map as a `.env` snippet. Header comments explain
 * provenance (this is just the override delta — baseline still comes from
 * deployment env). Keys sorted alphabetically for stable diffs across
 * re-exports.
 */
function renderOverrideExport(overrides: ReadonlyMap<string, string>): string {
  const now = new Date().toISOString();
  const header = [
    `# Goldpan UI overrides — exported on ${now}`,
    `# Baseline 来自部署环境 (.env / docker / k8s),本文件仅含 UI 修改的 override 部分。`,
    `# 用法:合并到现有 .env 或部署 env 后重新部署,可使"声明式部署"等价当前 UI 配置。`,
    ``,
  ].join('\n');
  const lines = [...overrides.keys()]
    .sort()
    .map((k) => `${k}=${escapeEnvValue(overrides.get(k) as string)}`);
  return `${header}${lines.join('\n')}\n`;
}

/**
 * One row of `GET /settings/env-state`.
 *
 * - `configured`: the key has a non-empty value at runtime (`process.env`).
 * - `source`: discriminated three-state literal driven by
 *   `ConfigStore.getSnapshot().origins`:
 *     - `'env'` — value comes from BOOT_ENV_SNAPSHOT (.env / external
 *       injection captured at process start).
 *     - `'override'` — value comes from a DB-persisted runtime override
 *       (a previous POST /settings/env or wizard commit).
 *     - `'default'` — no env baseline and no override (the loaded config
 *       fell back to the schema default, or the key is unset entirely).
 * - `baselineDiffers`: only meaningful when `source === 'override'`. True when
 *   bootEnv ALSO defines a non-empty value for this key but it differs from
 *   the live override — UI shows a hint that the .env baseline disagrees and
 *   would re-shadow if the user removes the override.
 * - `mask`: human-readable representation of the live value. Secrets (keys
 *   ending in KEY/TOKEN/SECRET/PASSWORD) are returned as `••••<last4>`;
 *   non-secret URL keys have any embedded `user:pass@` stripped; other
 *   non-secrets return the full value so the UI can render the current
 *   selection (e.g. `GOLDPAN_LANGUAGE=zh`).
 */
export interface EnvKeyState {
  key: string;
  configured: boolean;
  source: 'env' | 'override' | 'default';
  baselineDiffers?: boolean;
  mask: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the union of keys to surface in `/settings/env-state`:
 *   1. literal MANAGED_ENV_KEYS (core whitelist)
 *   2. `pluginEnvKeys` (plugin-contributed managed keys)
 *   3. dynamic keys present in the snapshot's origin map (e.g. brand-new
 *      GOLDPAN_LLM_PROVIDER_X_BASE_URL persisted in DB).
 *
 * Order is preserved — core keys first, then plugin keys, then dynamic.
 * Dedupe via a Set so plugins overlapping with core entries appear once.
 */
function collectAllKeys(
  origins: ReadonlyMap<string, 'env' | 'override' | 'default'>,
  pluginEnvKeys: ReadonlyArray<string>,
): string[] {
  const seen = new Set<string>();
  const allKeys: string[] = [];
  for (const k of MANAGED_ENV_KEYS) {
    if (!seen.has(k)) {
      seen.add(k);
      allKeys.push(k);
    }
  }
  for (const k of pluginEnvKeys) {
    if (!seen.has(k)) {
      seen.add(k);
      allKeys.push(k);
    }
  }
  for (const k of origins.keys()) {
    if (!seen.has(k)) {
      seen.add(k);
      allKeys.push(k);
    }
  }
  return allKeys;
}

function buildOneEnvState(
  key: string,
  origins: ReadonlyMap<string, 'env' | 'override' | 'default'>,
  bootEnv: Readonly<NodeJS.ProcessEnv>,
): EnvKeyState {
  const origin = origins.get(key) ?? 'default';
  const liveValue = process.env[key];
  const configured = typeof liveValue === 'string' && liveValue !== '';
  if (!configured) {
    return { key, configured: false, source: origin, mask: '' };
  }
  let baselineDiffers: boolean | undefined;
  if (origin === 'override') {
    const baseline = bootEnv[key];
    if (typeof baseline === 'string' && baseline !== '' && baseline !== liveValue) {
      baselineDiffers = true;
    }
  }
  const mask = isSecret(key) ? maskSecret(liveValue) : stripUrlCredentials(liveValue);
  const row: EnvKeyState = { key, configured: true, source: origin, mask };
  if (baselineDiffers) row.baselineDiffers = true;
  return row;
}

export function buildEnvState(
  configStore: ConfigStore,
  bootEnv: Readonly<NodeJS.ProcessEnv>,
  pluginEnvKeys: ReadonlyArray<string> = [],
): EnvKeyState[] {
  const snap = configStore.getSnapshot();
  const allKeys = collectAllKeys(snap.origins, pluginEnvKeys);
  return allKeys.map((key) => buildOneEnvState(key, snap.origins, bootEnv));
}

/**
 * Build env-state rows for a specific subset of keys. Used by the commit
 * handler to return up-to-date masks in the `ok` response — `commit()` has
 * already applied the patch to `process.env` synchronously, so reading the
 * snapshot here yields the post-commit live values.
 */
export function buildEnvStateForKeys(
  configStore: ConfigStore,
  bootEnv: Readonly<NodeJS.ProcessEnv>,
  keys: ReadonlyArray<string>,
): EnvKeyState[] {
  const snap = configStore.getSnapshot();
  return keys.map((key) => buildOneEnvState(key, snap.origins, bootEnv));
}

/**
 * Build the `/settings/*` route handler. Auth is enforced upstream by the
 * global POST guard + per-route `authRequired()` in `main.ts`; this handler
 * trusts the caller is authenticated.
 *
 * Endpoints:
 * - `GET /settings/env-state` → `{ items: EnvKeyState[] }` covering core
 *   `MANAGED_ENV_KEYS` plus every `deps.pluginEnvKeys` entry plus any
 *   dynamic key persisted in the snapshot's origin map (de-duped).
 *   Secrets are masked; `source` discriminates env / override / default.
 * - `POST /settings/env` with `{ patch: { KEY: value | null, ... } }` →
 *   route through `configStore.commit` to validate (plugin schemas + core
 *   cross-field) and persist as a DB-backed runtime override, then apply
 *   to `process.env` and notify listeners. Whitelist + dynamic-allowlist
 *   enforcement happens inside `validateStaged`; SSRF on base URLs is
 *   enforced here before the commit so core stays SSRF-agnostic.
 * - `GET /settings/export-overrides` → renders DB overrides as a `.env`
 *   snippet (header comments + KEY=value lines, alphabetically sorted).
 *   Reads directly from `runtimeConfigOverrideRepo`; baseline / defaults
 *   are intentionally excluded.
 */
export function createSettingsRoutes(deps: SettingsRouteDeps) {
  const pluginEnvKeys: ReadonlyArray<string> = deps.pluginEnvKeys ?? [];

  return async function handleSettingsRoutes(ctx: RouteContext): Promise<void> {
    const { req, res, segments, readBody, handle } = ctx;

    if (req.method === 'GET' && segments.length === 1 && segments[0] === 'env-state') {
      req.resume();
      respond(res, 200, { items: buildEnvState(deps.configStore, deps.bootEnv, pluginEnvKeys) });
      return;
    }

    if (req.method === 'GET' && segments.length === 1 && segments[0] === 'export-overrides') {
      req.resume();
      const overrides = deps.runtimeConfigOverrideRepo.list();
      const text = renderOverrideExport(overrides);
      const dateSegment = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="goldpan-overrides-${dateSegment}.env"`,
        'Cache-Control': 'no-store, private',
      });
      res.end(text);
      return;
    }

    if (req.method === 'POST' && segments.length === 1 && segments[0] === 'env') {
      const body = await readBody();
      if (body === null) return;
      const parsed = parseJsonBody<{ patch?: unknown }>(res, body);
      if (parsed === null) return;
      if (
        typeof parsed.patch !== 'object' ||
        parsed.patch === null ||
        Array.isArray(parsed.patch)
      ) {
        respondError(res, 400, 'invalid_input', '"patch" must be an object');
        return;
      }
      const patchObj = parsed.patch as Record<string, unknown>;

      // Build the ConfigPatch — null means "delete this override / revert to
      // baseline" (the new explicit revert semantics from PR 1). Any non-string
      // non-null value is rejected upfront so we don't pass garbage into the
      // store. The whitelist / dynamic-allowlist check happens inside
      // `validateStaged` (called by `configStore.commit`), so we don't need to
      // duplicate it here.
      const patch = new Map<string, string | null>();
      const invalidValues: string[] = [];
      for (const [key, value] of Object.entries(patchObj)) {
        if (value === null) patch.set(key, null);
        else if (typeof value === 'string') patch.set(key, value);
        else invalidValues.push(key);
      }
      if (invalidValues.length > 0) {
        respondError(
          res,
          400,
          'invalid_values',
          `non-string non-null values for: ${invalidValues.join(', ')}`,
        );
        return;
      }
      if (patch.size === 0) {
        respondError(res, 400, 'empty_patch', 'patch must contain at least one key');
        return;
      }

      // SSRF check (route-layer, before commit — keeps core SSRF-agnostic).
      // Only the string entries of the patch carry base URLs worth resolving;
      // null entries (revert to baseline) cannot introduce a new SSRF target.
      try {
        await validateStagedBaseUrls(stripNulls(patch));
      } catch (e) {
        if (isTransientDnsError(e)) {
          handle.logger.error('POST /settings/env DNS resolver failure', { err: errorMessage(e) });
          respondError(res, 502, 'upstream_dns', 'DNS resolution failed; try again');
          return;
        }
        respond(res, 400, {
          kind: 'errors',
          errors: [{ path: '', message: errorMessage(e) }],
        });
        return;
      }

      try {
        const result = await deps.configStore.commit(patch, {
          pluginEnvSchemas: deps.pluginEnvSchemas,
          knownLlmProviderIds: deps.knownLlmProviderIds,
        });
        if (result.kind === 'errors') {
          respond(res, 400, { kind: 'errors', errors: result.errors });
          return;
        }
        // `pendingRestartKeys` lists keys whose committed value cannot take
        // effect in the current process — server's request-scoped reads from
        // the boot-time `handle.config` snapshot or web's separate-process
        // `process.env` see the OLD value until both processes restart.
        // Only static, well-known boot-only keys are surfaced today; later
        // PRs may extend this to plugin-declared `restartRequired` metadata.
        //
        // `commit()` mutates `process.env` to the merged effective values.
        // We compare each restart-required key's post-commit effective value
        // against the boot-EFFECTIVE baseline (`.env` + the DB overrides that
        // were applied at boot — what the boot-frozen readers actually loaded),
        // NOT the pre-merge `.env` (`deps.bootEnv`):
        //   - effective !== boot  → genuinely pending (UI dialog + /health)
        //   - effective === boot  → user reverted to the running value; nothing
        //                            pending (boot-frozen readers already have
        //                            it). Tell main.ts to remove it from the
        //                            lifetime Set so we don't leak "pending
        //                            forever" entries.
        // Comparing against pre-merge `.env` was the bug: a restart-required
        // key set ONLY via a DB override (absent from `.env`) compared against
        // '' and could never resolve, so /health nagged forever even after the
        // user reverted to the running value. `bootEffectiveEnv` carries the
        // merged-at-boot values; it falls back to `bootEnv` when a caller
        // (e.g. tests) supplies no separate boot-merge snapshot.
        // Note: a no-op write (committing the same value that was already both
        // effective and boot) lands in `resolvedRestartKeys`, a harmless
        // redundant `delete` on the lifetime Set.
        const bootEffectiveEnv = deps.bootEffectiveEnv ?? deps.bootEnv;
        const pendingRestartKeys: string[] = [];
        const resolvedRestartKeys: string[] = [];
        for (const key of patch.keys()) {
          if (!isStaticRestartRequiredKey(key)) continue;
          const effective = process.env[key] ?? '';
          const boot = bootEffectiveEnv[key] ?? '';
          if (effective === boot) resolvedRestartKeys.push(key);
          else pendingRestartKeys.push(key);
        }
        if (pendingRestartKeys.length > 0) {
          deps.onPendingRestart?.(pendingRestartKeys);
        }
        if (resolvedRestartKeys.length > 0) {
          deps.onResolveRestart?.(resolvedRestartKeys);
        }
        respond(res, 200, {
          kind: 'ok',
          updatedItems: buildEnvStateForKeys(deps.configStore, deps.bootEnv, [...patch.keys()]),
          pendingRestartKeys,
        });
      } catch (err) {
        handle.logger.error('POST /settings/env failed', { err: errorMessage(err) });
        respondError(res, 500, 'internal', 'Internal error');
      }
      return;
    }

    req.resume();
    respondError(res, 404, 'not_found', 'Unknown settings route');
  };
}
