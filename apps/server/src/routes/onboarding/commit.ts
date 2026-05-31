// apps/server/src/routes/onboarding/commit.ts
import type http from 'node:http';
import type { WizardBootstrapHandle } from '@goldpan/core/bootstrap';
import type { MetadataRepository } from '@goldpan/core/db/repositories';
import {
  applyMetadata,
  type DigestInitialPreset,
  type TrackingInitialRule,
} from '@goldpan/core/onboarding';
import type { ImSettingsManifest } from '@goldpan/im-runtime';
import type { ZodRawShape } from 'zod';
import { isTransientDnsError, validateStagedBaseUrls } from '../../lib/base-url-security.js';
import { respond, respondError } from '../types.js';
import { readJsonBody } from './_body.js';
import { getWizardState, type WizardState } from './state.js';

/**
 * Serialize an in-memory `WizardState` into a flat `Map<env-key, value>` for
 * the env-file writer. Only emits keys we know about — never leaks unmanaged
 * state, so we don't need to filter through `MANAGED_ENV_KEYS` at the
 * call-site.
 *
 * Notes (kept here so the next reader doesn't re-derive them):
 * - `state.tracking.searchProviders` and `state.tracking.rules` are NOT
 *   serialized — the former only shapes which API-key fields we collect, the
 *   latter is metadata seed (handled by `applyMetadata` in the commit handler).
 * - `state.digest.modules` likewise is metadata seed, not env.
 * - `state.embedding.dimensions === 0` is the explicit "auto-detect at
 *   bootstrap" sentinel — pass through as-is, envSchema treats 0 as the
 *   trigger for the runtime probe code path.
 */
export function stateToEnvKeys(
  state: WizardState,
  manifests: ReadonlyArray<ImSettingsManifest> = [],
): Map<string, string> {
  const m = new Map<string, string>();

  if (state.language) m.set('GOLDPAN_LANGUAGE', state.language);
  if (state.timezone) m.set('GOLDPAN_TIMEZONE', state.timezone);
  if (state.webEnabled !== undefined) m.set('GOLDPAN_WEB_ENABLED', String(state.webEnabled));
  if (state.authPassword) m.set('GOLDPAN_AUTH_PASSWORD', state.authPassword);

  // LLM providers
  if (state.providers.openai?.apiKey) m.set('OPENAI_API_KEY', state.providers.openai.apiKey);
  if (state.providers.openai?.baseUrl) m.set('OPENAI_BASE_URL', state.providers.openai.baseUrl);
  if (state.providers.anthropic?.apiKey)
    m.set('ANTHROPIC_API_KEY', state.providers.anthropic.apiKey);
  if (state.providers.deepseek?.apiKey) m.set('DEEPSEEK_API_KEY', state.providers.deepseek.apiKey);
  if (state.providers.deepseek?.baseUrl)
    m.set('DEEPSEEK_BASE_URL', state.providers.deepseek.baseUrl);
  if (state.providers.google?.apiKey)
    m.set('GOOGLE_GENERATIVE_AI_API_KEY', state.providers.google.apiKey);
  if (state.providers.ollama?.baseUrl) m.set('OLLAMA_BASE_URL', state.providers.ollama.baseUrl);
  if (state.providers.ollama) m.set('GOLDPAN_OLLAMA_ENABLED', 'true');
  if (state.providers.openrouter?.apiKey)
    m.set('OPENROUTER_API_KEY', state.providers.openrouter.apiKey);
  if (state.providers.openrouter?.baseUrl)
    m.set('OPENROUTER_BASE_URL', state.providers.openrouter.baseUrl);

  // Per-provider model lists + custom OpenAI-compat provider registration.
  //
  // Mirrors the settings-page contract (see
  // `apps/web/src/app/settings/groups/_components/add-openai-compat-modal.tsx`):
  //   - Chat models: non-empty `cfg.models` → `_MODELS=<csv>`
  //   - Embedding models: non-empty `cfg.embeddingModels` → `_EMBEDDING_MODELS=<csv>`
  //     chat 和 embedding 在真实模型层面集合互斥，由用户在 Provider 编辑器
  //     里逐行打 toggle 决定 model id 落到哪栏。
  //   - 空数组都跳过，不让未填的 provider 留下空 env var。
  //   - Custom providers (id NOT in the builtin set) additionally need the
  //     server to know how to call them. We emit:
  //       * `GOLDPAN_LLM_PROVIDER_<UPPER_ID>_BASE_URL`
  //       * `GOLDPAN_LLM_PROVIDER_<UPPER_ID>_API_KEY_ENV`
  //       * the secret itself at the dynamic name `cfg.apiKeyEnv`
  //     The builtin path above already handled their hardcoded secret env
  //     names (OPENAI_API_KEY etc.), so this branch is custom-only.
  const BUILTIN_IDS = new Set([
    'openai',
    'anthropic',
    'deepseek',
    'openrouter',
    'google',
    'ollama',
  ]);
  for (const [providerId, cfg] of Object.entries(state.providers)) {
    const upperId = providerId.toUpperCase().replace(/-/g, '_');
    if (cfg?.models && cfg.models.length > 0) {
      m.set(`GOLDPAN_LLM_PROVIDER_${upperId}_MODELS`, cfg.models.join(','));
    }
    if (cfg?.embeddingModels && cfg.embeddingModels.length > 0) {
      m.set(`GOLDPAN_LLM_PROVIDER_${upperId}_EMBEDDING_MODELS`, cfg.embeddingModels.join(','));
    }
    if (BUILTIN_IDS.has(providerId)) continue;
    if (cfg?.baseUrl) m.set(`GOLDPAN_LLM_PROVIDER_${upperId}_BASE_URL`, cfg.baseUrl);
    if (cfg?.apiKeyEnv) {
      m.set(`GOLDPAN_LLM_PROVIDER_${upperId}_API_KEY_ENV`, cfg.apiKeyEnv);
      if (cfg.apiKey) m.set(cfg.apiKeyEnv, cfg.apiKey);
    }
  }

  // Step → env key map. The 8 LLM-driven pipeline steps + 2 toggle keys
  // (`GOLDPAN_LLM_VERIFIER_ENABLED`, `GOLDPAN_RELATION_ENABLED`) map to the
  // same env names bootstrap reads in normal mode.
  const stepEnvMap: Record<string, string> = {
    classifier: 'GOLDPAN_LLM_CLASSIFIER',
    extractor: 'GOLDPAN_LLM_EXTRACTOR',
    matcher: 'GOLDPAN_LLM_MATCHER',
    comparator: 'GOLDPAN_LLM_COMPARATOR',
    verifier: 'GOLDPAN_LLM_VERIFIER',
    relator: 'GOLDPAN_LLM_RELATOR',
    intent: 'GOLDPAN_LLM_INTENT',
    query: 'GOLDPAN_LLM_QUERY',
  };
  for (const [step, env] of Object.entries(stepEnvMap)) {
    const cfg = state.steps[step];
    if (cfg?.model) m.set(env, cfg.model);
  }
  if (state.steps.verifier?.enabled) m.set('GOLDPAN_LLM_VERIFIER_ENABLED', 'true');
  if (state.steps.relator?.enabled) m.set('GOLDPAN_RELATION_ENABLED', 'true');

  // Digest
  if (state.digest?.enabled) {
    m.set('GOLDPAN_DIGEST_ENABLED', 'true');
    if (state.digest.dailyTime) m.set('GOLDPAN_DIGEST_DAILY_TIME', state.digest.dailyTime);
    if (state.digest.maxItemsPerModule !== undefined)
      m.set('GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE', String(state.digest.maxItemsPerModule));
    if (state.digest.summaryModel) m.set('GOLDPAN_LLM_DIGEST_SUMMARY', state.digest.summaryModel);
    if (state.digest.actionModel) m.set('GOLDPAN_LLM_DIGEST_ACTION', state.digest.actionModel);
  }

  // Tracking
  if (state.tracking?.enabled) {
    m.set('GOLDPAN_TRACKING_SCHEDULER_ENABLED', 'true');
    if (state.tracking.pollInterval !== undefined)
      m.set('GOLDPAN_TRACKING_POLL_INTERVAL', String(state.tracking.pollInterval));
    if (state.tracking.dailyLimit !== undefined)
      m.set('GOLDPAN_TRACKING_DAILY_SEARCH_LIMIT', String(state.tracking.dailyLimit));
  }
  // Search-provider API keys — kept on a separate slice from `providers`
  // because they're search-tool keys, not LLM provider keys (see
  // WizardState.searchKeys in state.ts).
  if (state.searchKeys?.tavily) m.set('TAVILY_API_KEY', state.searchKeys.tavily);
  if (state.searchKeys?.serper) m.set('SERPER_API_KEY', state.searchKeys.serper);

  // Embedding
  if (state.embedding?.enabled) {
    m.set('GOLDPAN_EMBEDDING_ENABLED', 'true');
    if (state.embedding.model) m.set('GOLDPAN_EMBEDDING_MODEL', state.embedding.model);
    if (state.embedding.dimensions !== undefined)
      m.set('GOLDPAN_EMBEDDING_DIMENSIONS', String(state.embedding.dimensions));
    if (state.embedding.batchSize !== undefined)
      m.set('GOLDPAN_EMBEDDING_BATCH_SIZE', String(state.embedding.batchSize));
  }

  // IM channels — driven by manifests so adding a plugin is zero changes here.
  //
  // 持久化语义：用户在 wizard 里 touch 过某个 channel（channelState !== undefined）
  // 就 stage 它的 enable.envKey + 所有填过的字段。enabled=false 也要写
  // `enable.envKey='false'` —— 否则用户先 toggle on 再 toggle off 时，旧的 'true'
  // 仍然在 .env 里，重启后会按默认 default 启动 channel，而 commit-preview 也看
  // 不到关闭意图。
  for (const manifest of manifests) {
    const channelState = state.im?.[manifest.channelId];
    if (!channelState) continue;
    m.set(manifest.enable.envKey, channelState.enabled ? 'true' : 'false');
    for (const field of manifest.fields) {
      const v = channelState.fields?.[field.name];
      if (v !== undefined && v !== '') m.set(field.envKey, v);
    }
  }

  return m;
}

/**
 * Build the GET `/onboarding/commit-preview` handler.
 *
 * Read-only counterpart to `createCommitHandler`. Serializes the in-memory
 * wizard state into a flat `stagedKeys: { KEY: value }` record so the F8
 * summary card can render the staging set (the client redacts known-secret
 * keys via `secret-mask.ts` before display). The handler does not touch
 * `.env` — wizard commit persists as DB-backed runtime overrides, so there
 * is no rendered file content to preview.
 */
export function createCommitPreviewHandler(manifests: ReadonlyArray<ImSettingsManifest>) {
  return function handleCommitPreview(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'GET') {
      respondError(res, 405, 'method_not_allowed', 'Use GET');
      return;
    }
    req.resume();
    const state = getWizardState();
    const stagedKeys = stateToEnvKeys(state, manifests);
    const stagedRecord: Record<string, string> = {};
    for (const [k, v] of stagedKeys) stagedRecord[k] = v;
    respond(res, 200, { stagedKeys: stagedRecord });
  };
}

export interface CommitHandlerDeps {
  /**
   * Wizard handle's `commitOverrides` — persists the staged patch as DB-backed
   * runtime overrides (no `.env` write). Mirrors the normal-mode `/settings/env`
   * commit path so both flows share validation, plugin schema checking, and
   * apply semantics; the wizard variant skips the post-commit snapshot
   * (strict `loadConfig` would throw on incomplete wizard config — see
   * `WizardCommitResult` rationale in core/config/store-types.ts).
   */
  commitOverrides: WizardBootstrapHandle['commitOverrides'];
  metadataRepo: MetadataRepository;
  hasExistingData?: boolean;
  logger: { error: (msg: string, ctx?: unknown) => void };
  manifests: ReadonlyArray<ImSettingsManifest>;
  /**
   * Plugin-managed env-key whitelist (e.g. enable.envKey + fields[].envKey
   * from each IM channel manifest). Forwarded into `commitOverrides` so
   * `validateStaged` accepts these keys; without it the wizard's IM-channel
   * patch entries would reject as "outside whitelist".
   */
  pluginEnvKeys?: ReadonlyArray<string>;
  /**
   * Plugin envSpec.envSchema shapes — forwarded into `commitOverrides` so
   * wizard commit catches bad plugin-managed values (e.g.
   * GOLDPAN_IM_FEISHU_DOMAIN outside the enum) BEFORE the DB write. Without
   * this the next boot would be the first thing to fail.
   */
  pluginEnvSchemas?: ReadonlyArray<ZodRawShape>;
  /**
   * LLM provider ids contributed by plugins. Wizard commit validates staged
   * `provider:model` references before persistence; builtin/custom ids are
   * known to core, while plugin ids must be supplied by the wizard server.
   */
  knownLlmProviderIds?: ReadonlyArray<string>;
}

/**
 * Build the POST `/onboarding/commit` handler.
 *
 * Flow: SSRF-check staged base URLs → `commitOverrides` (validate + persist
 * as DB-backed runtime overrides) → best-effort metadata seed → return
 * `{ kind: 'ok', restartUrl }`. Validation rejection comes back as
 * `{ kind: 'errors', errors }`. There is no `.env` write path: wizard mode
 * persists overrides into the DB, so read-only filesystem mounts no longer
 * need a manual-copy fallback.
 *
 * Metadata-seed failure does NOT roll back the override commit — overrides
 * are the source of truth for restart, and rolling them back would lose the
 * user's config. We log and surface `metadataSeedFailed` so the UI can warn;
 * the digest / tracking plugin postInits gracefully no-op when the seed key
 * is absent.
 */
export function createCommitHandler(deps: CommitHandlerDeps) {
  return async function handleCommit(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      respondError(res, 405, 'method_not_allowed', 'Use POST');
      return;
    }
    // Body is empty for POST /onboarding/commit (we use in-memory wizard
    // state). Drain anyway so keep-alive doesn't deadlock if a client sent
    // body bytes we don't read.
    const body = await readJsonBody(req, res);
    if (body === null) return;

    const state = getWizardState();
    const stagedKeys = stateToEnvKeys(state, deps.manifests);

    // 1. SSRF check (route-layer, before commitOverrides) — keeps core's
    //    `validateStaged` SSRF-agnostic. Without this, a wizard commit could
    //    persist `OPENAI_BASE_URL=http://169.254.169.254/...` and the next LLM
    //    call would hit an internal cloud-metadata endpoint. Mirrors the
    //    normal-mode `/settings/env` route's same check.
    try {
      await validateStagedBaseUrls(stagedKeys);
    } catch (e) {
      if (isTransientDnsError(e)) {
        deps.logger.error('Wizard /onboarding/commit DNS resolver failure', {
          err: e instanceof Error ? e.message : String(e),
        });
        respondError(res, 502, 'upstream_dns', 'DNS resolution failed; try again');
        return;
      }
      respond(res, 400, {
        kind: 'errors',
        ok: false,
        errors: [{ path: '', message: e instanceof Error ? e.message : String(e) }],
      });
      return;
    }

    // 2. Apply staged keys as DB-backed runtime overrides. Wizard never
    //    deletes overrides (only stages new values), so the patch is a plain
    //    `Map<string, string>` widened to the `Map<string, string | null>`
    //    shape `commitOverrides` accepts.
    const result = await deps.commitOverrides(stagedKeys, {
      pluginEnvKeys: deps.pluginEnvKeys,
      pluginEnvSchemas: deps.pluginEnvSchemas,
      knownLlmProviderIds: deps.knownLlmProviderIds,
    });
    if (result.kind === 'errors') {
      respond(res, 400, { kind: 'errors', ok: false, errors: result.errors });
      return;
    }

    // 2. Apply metadata seed (best-effort; .env is now correct, do not roll back)
    let metadataSeedFailed = false;
    try {
      const digestPreset: DigestInitialPreset | undefined = state.digest?.enabled
        ? {
            modules: state.digest.modules,
            maxItems: state.digest.maxItemsPerModule ?? 10,
          }
        : undefined;
      const trackingRules: TrackingInitialRule[] | undefined =
        state.tracking?.enabled && state.tracking.rules.length > 0
          ? state.tracking.rules.map((r) => ({
              name: r.name,
              searchQueries: r.searchQueries,
              intervalMinutes: r.intervalMinutes,
            }))
          : undefined;
      applyMetadata(deps.metadataRepo, {
        language: state.language,
        hasExistingData: deps.hasExistingData,
        digestPreset,
        trackingRules,
      });
    } catch (e) {
      // Honest: log but do not roll back .env (would lose the user's config).
      // Plugin postInit will simply not seed; user can configure /digest /tracking manually.
      // Surface the failure to the client so F8 can render a warning — silently
      // returning `ok: true` would mislead the user into thinking digest /
      // tracking presets were saved.
      metadataSeedFailed = true;
      deps.logger.error('Wizard: failed to write metadata seed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }

    respond(res, 200, {
      kind: 'ok',
      ok: true,
      restartUrl: '/server/restart',
      ...(metadataSeedFailed ? { metadataSeedFailed: true } : {}),
    });
  };
}
