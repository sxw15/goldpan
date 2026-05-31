import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { detectHostTimezone, isValidIanaTz } from '../lib/tz';
import {
  type CustomLlmProvider,
  parseCustomLlmProviders,
  parseProviderEmbeddingModels,
  parseProviderModels,
} from './llm-providers';

export {
  type CustomLlmProvider,
  parseCustomLlmProviders,
  parseProviderEmbeddingModels,
  parseProviderModels,
} from './llm-providers';

const modelIdSchema = z.string().refine(
  (s) => {
    const colonIdx = s.indexOf(':');
    if (colonIdx <= 0 || colonIdx === s.length - 1) return false;
    const provider = s.slice(0, colonIdx);
    return /^[a-z][a-z0-9_-]*$/.test(provider);
  },
  {
    message:
      'Must be providerId:modelId format (e.g., deepseek:deepseek-v4-flash, ollama:qwen2.5:7b)',
  },
);

/**
 * Per-step provider options (reasoning / thinking, etc.) accept a JSON object
 * that is forwarded verbatim to Vercel AI SDK as `providerOptions[<provider>]`.
 * Empty / unset → undefined; non-object JSON → schema error.
 *
 * See {@link GoldpanConfig.llmProviderOptions} for the per-step / per-provider
 * shape, and Vercel docs for each provider's accepted fields:
 * https://ai-sdk.dev/providers/ai-sdk-providers
 */
const optionsJsonSchema = z
  .string()
  .optional()
  .transform((s, ctx) => {
    if (s === undefined || s.trim() === '') return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid JSON: ${(e as Error).message}`,
      });
      return z.NEVER;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be a JSON object (got null/array/scalar)',
      });
      return z.NEVER;
    }
    return parsed as Record<string, unknown>;
  });

// PROVIDERS_WITH_OPTIONS lives in `../llm/reasoning-tiers` so client UI code
// can import it without pulling `node:fs` (this file imports `onboarding/env-file`
// which is server-only). Re-exported here for backend callers / external API
// stability; also imported below for use inside this file's schema definitions.
import { PROVIDERS_WITH_OPTIONS, type ProviderWithOptions } from '../llm/reasoning-tiers';

export { PROVIDERS_WITH_OPTIONS, type ProviderWithOptions };

/** Step keys that map to a configured LLM model and accept per-step options. Mirrors `LlmModelKey`. */
export const STEPS_WITH_OPTIONS = [
  'classifier',
  'extractor',
  'matcher',
  'comparator',
  'verifier',
  'relator',
  'translator',
  'intent',
  'query',
  'digestSummary',
  'digestAction',
] as const;
export type StepWithOptions = (typeof STEPS_WITH_OPTIONS)[number];

/** Map step → uppercase env-var segment (e.g., `digestSummary` → `DIGEST_SUMMARY`). */
const STEP_ENV_SEGMENT: Record<StepWithOptions, string> = {
  classifier: 'CLASSIFIER',
  extractor: 'EXTRACTOR',
  matcher: 'MATCHER',
  comparator: 'COMPARATOR',
  verifier: 'VERIFIER',
  relator: 'RELATOR',
  translator: 'TRANSLATOR',
  intent: 'INTENT',
  query: 'QUERY',
  digestSummary: 'DIGEST_SUMMARY',
  digestAction: 'DIGEST_ACTION',
};

// Per-step provider options (reasoning / thinking, etc.).
// Format: GOLDPAN_LLM_<STEP>_<PROVIDER>_OPTIONS=<json-object>
// Content is forwarded verbatim as `providerOptions[<provider>]` to the AI SDK.
// See https://ai-sdk.dev/providers/ai-sdk-providers for each provider's shape.
const llmStepProviderOptionsShape = Object.fromEntries(
  STEPS_WITH_OPTIONS.flatMap((step) =>
    PROVIDERS_WITH_OPTIONS.map(
      (provider) =>
        [
          `GOLDPAN_LLM_${STEP_ENV_SEGMENT[step]}_${provider.toUpperCase()}_OPTIONS`,
          optionsJsonSchema,
        ] as const,
    ),
  ),
) as Record<string, typeof optionsJsonSchema>;

// Per-step LLM timeout overrides.
// Format: GOLDPAN_LLM_<STEP>_TIMEOUT=<seconds>
// Empty / unset → falls back to the global `GOLDPAN_LLM_TIMEOUT`.
const stepTimeoutSchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.coerce.number().int().min(1).max(600).optional());
const llmStepTimeoutShape = Object.fromEntries(
  STEPS_WITH_OPTIONS.map(
    (step) => [`GOLDPAN_LLM_${STEP_ENV_SEGMENT[step]}_TIMEOUT`, stepTimeoutSchema] as const,
  ),
) as Record<string, typeof stepTimeoutSchema>;

/** Env key for a step's per-step timeout override. */
export function stepTimeoutEnvKey(step: StepWithOptions): string {
  return `GOLDPAN_LLM_${STEP_ENV_SEGMENT[step]}_TIMEOUT`;
}

const envSchema = z
  .object({
    // LLM models
    GOLDPAN_LLM_CLASSIFIER: modelIdSchema.default('openai:gpt-4o-mini'),
    GOLDPAN_LLM_EXTRACTOR: modelIdSchema.default('anthropic:claude-sonnet-4-20250514'),
    GOLDPAN_LLM_MATCHER: modelIdSchema.default('anthropic:claude-sonnet-4-20250514'),
    GOLDPAN_LLM_COMPARATOR: modelIdSchema.default('anthropic:claude-sonnet-4-20250514'),
    GOLDPAN_LLM_VERIFIER: z.string().default('openai:gpt-4o-mini'),
    GOLDPAN_LLM_VERIFIER_ENABLED: z.enum(['true', 'false']).default('false'),
    GOLDPAN_LLM_INTENT: modelIdSchema.default('openai:gpt-4o-mini'),
    GOLDPAN_LLM_QUERY: modelIdSchema.default('anthropic:claude-sonnet-4-20250514'),

    ...llmStepProviderOptionsShape,
    ...llmStepTimeoutShape,

    // Relation extraction
    GOLDPAN_RELATION_ENABLED: z.enum(['true', 'false']).default('false'),
    GOLDPAN_LLM_RELATOR: modelIdSchema.default('openai:gpt-4o-mini'),

    // Content tracking
    GOLDPAN_TRACKING_SCHEDULER_ENABLED: z.enum(['true', 'false']).default('false'),

    // Digest
    GOLDPAN_DIGEST_ENABLED: z.enum(['true', 'false']).default('false'),
    // HH:MM, UTC. Scheduler fires at this UTC time each day for yesterday's UTC window.
    GOLDPAN_DIGEST_DAILY_TIME: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default('06:00'),
    GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE: z.coerce.number().int().positive().default(10),
    GOLDPAN_LLM_DIGEST_SUMMARY: modelIdSchema.default('anthropic:claude-sonnet-4-20250514'),
    GOLDPAN_LLM_DIGEST_ACTION: modelIdSchema.default('openai:gpt-4o-mini'),
    GOLDPAN_DIGEST_LINK_SIGNING_KEY: z
      .string()
      .min(32, 'must be at least 32 characters (recommend 64+ random hex)')
      .optional(),
    GOLDPAN_DIGEST_LINK_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
    // share URL 前缀:必须是 http(s) origin (可带 path),不接受 query/fragment/
    // 非 http 协议。`mintShareUrl` 直接拼 `${baseUrl}/digest/share/${id}?sig=...`,
    // 如果 baseUrl 自带 query/fragment 会拼出坏 URL;非 http(s) 协议(ftp/file/javascript)
    // 用户复制粘贴时也无法在浏览器里打开。
    GOLDPAN_DIGEST_PUBLIC_BASE_URL: z
      .url()
      .refine(
        (s) => {
          try {
            const u = new URL(s);
            return (u.protocol === 'http:' || u.protocol === 'https:') && !u.search && !u.hash;
          } catch {
            return false;
          }
        },
        { message: 'must be an http(s) URL without query string or fragment' },
      )
      .optional(),

    // IM subsystem — channel-specific env keys (GOLDPAN_IM_TELEGRAM_*, GOLDPAN_IM_FEISHU_*)
    // are now owned by each plugin's `goldpanIMEnvSpec` (see `monorepo/plugins/im-*`).
    // Core only retains runtime-level knobs that apply across all channels.
    GOLDPAN_IM_CONVERSATION_WINDOW_SIZE: z.coerce.number().int().positive().default(8),
    GOLDPAN_IM_CONVERSATION_TTL_DAYS: z.coerce.number().int().positive().default(30),
    // Inbound dedupe (im_messages_seen) retention window. The table only protects against
    // crash/cursor-rewind double-deliveries, so a few days of memory is plenty. Set to 0 to
    // disable the periodic purge entirely (rows accumulate forever).
    GOLDPAN_IM_DEDUPE_TTL_HOURS: z.coerce.number().int().nonnegative().default(72),
    // How often the runtime sweeps im_messages_seen for expired rows. Set to 0 to disable.
    GOLDPAN_IM_DEDUPE_PURGE_INTERVAL_MINUTES: z.coerce.number().int().nonnegative().default(60),

    // Embeddings (hybrid search / sqlite-vec)
    GOLDPAN_EMBEDDING_ENABLED: z.enum(['true', 'false']).default('false'),
    GOLDPAN_EMBEDDING_MODEL: modelIdSchema.default('openai:text-embedding-3-small'),
    GOLDPAN_EMBEDDING_DIMENSIONS: z.coerce.number().int().nonnegative().default(0),
    GOLDPAN_EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(100),

    // Pipeline params
    GOLDPAN_WORKER_INTERVAL: z.coerce.number().int().positive().default(5),
    GOLDPAN_COLLECT_TIMEOUT: z.coerce.number().int().positive().default(30),
    /** How collector-browser launches Chromium: bundled install, system Chrome, or try Chrome then bundled */
    GOLDPAN_BROWSER_STRATEGY: z.enum(['auto', 'bundled', 'system-chrome']).default('auto'),

    // Collector-media (yt-dlp 视频源)
    /** 视频 collector 整体超时（秒），独立于 GOLDPAN_COLLECT_TIMEOUT */
    GOLDPAN_MEDIA_COLLECT_TIMEOUT: z.coerce.number().int().positive().default(90),
    /** yt-dlp 自动检查更新；关闭后只用本地 PINNED 版本 */
    GOLDPAN_YT_DLP_AUTO_UPDATE: z.enum(['true', 'false']).default('true'),
    /** 钉死特定 yt-dlp 版本（覆盖 auto-update） */
    GOLDPAN_YT_DLP_VERSION: z.string().optional(),
    /** 外部 yt-dlp binary 路径（跳过下载/升级） */
    GOLDPAN_YT_DLP_BINARY_PATH: z.string().optional(),
    /** yt-dlp binary + version.txt 存放位置（默认 ${dataDir}/yt-dlp） */
    GOLDPAN_YT_DLP_DIR: z.string().optional(),
    /** GitHub latest 查询缓存（小时） */
    GOLDPAN_YT_DLP_UPDATE_CHECK_INTERVAL_H: z.coerce.number().int().positive().default(24),
    /** yt-dlp cookies.txt 路径（B 站会员视频等场景） */
    GOLDPAN_YT_DLP_COOKIES_PATH: z.string().optional(),
    GOLDPAN_LLM_TIMEOUT: z.coerce.number().int().positive().default(600),
    GOLDPAN_OUTPUT_FULL_THRESHOLD: z.coerce.number().int().nonnegative().default(2),
    GOLDPAN_OUTPUT_INCREMENT_THRESHOLD: z.coerce.number().int().positive().default(10),
    GOLDPAN_MAX_TEXT_INPUT_LENGTH: z.coerce.number().int().positive().default(20000),
    GOLDPAN_MAX_CONTENT_LENGTH: z.coerce.number().int().positive().default(30000),
    GOLDPAN_MIN_CONTENT_LENGTH: z.coerce.number().int().positive().default(50),
    /**
     * Max characters sent to the intent classifier (handleInput → classifyIntent).
     * 0 = no truncation (full input up to maxTextInputLength).
     */
    GOLDPAN_INTENT_CLASSIFICATION_CHAR_LIMIT: z.coerce.number().int().nonnegative().default(0),

    // Logging
    GOLDPAN_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    GOLDPAN_LLM_LOG_PAYLOADS: z.enum(['true', 'false']).optional(),

    // Database
    GOLDPAN_DB_TYPE: z.enum(['sqlite', 'postgresql']).default('sqlite'),
    GOLDPAN_DB_SQLITE_PATH: z.string().min(1).default('./data/goldpan.db'),
    GOLDPAN_DB_URL: z.string().optional(),

    // Language
    GOLDPAN_LANGUAGE: z.enum(['en', 'zh']).default('en'),

    // Translate pipeline-produced natural-language fields (fact/opinion
    // content, entity description, relation description, summary, verifier
    // reason) into GOLDPAN_LANGUAGE. Original text stays in DB; the UI shows
    // the translation by default and can flip back to the original on demand.
    // Hot-reloadable: next pipeline run picks up the change.
    GOLDPAN_TRANSLATE_PIPELINE_OUTPUT: z.enum(['true', 'false']).default('false'),
    GOLDPAN_LLM_TRANSLATOR: modelIdSchema.default('openai:gpt-4o-mini'),

    // Timezone (IANA tz; default is host-detected via Intl + process.env.TZ)
    GOLDPAN_TIMEZONE: z
      .string()
      .min(1, 'timezone must be a non-empty IANA tz string')
      .refine((s) => isValidIanaTz(s), {
        message:
          'timezone must be a valid IANA tz (e.g. "Asia/Shanghai", "America/New_York", "Etc/GMT-8")',
      })
      .default(() => detectHostTimezone()),

    /**
     * Standalone HTTP server (`apps/server`): socket inactivity timeout in ms.
     * 0 = Node default (no timeout). A positive value closes idle connections after
     * this many ms — must exceed worst-case LLM wall time for `/input` and POST `/query`.
     */
    GOLDPAN_SERVER_SOCKET_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(0),

    /**
     * Standalone HTTP server (`apps/server`): trust X-Forwarded-For / X-Real-IP
     * headers for rate-limit keying. Only enable when the server sits behind a
     * trusted reverse proxy that strips/overwrites forwarded-for headers.
     */
    GOLDPAN_TRUST_PROXY: z.enum(['true', 'false', '0', '1']).default('false'),

    /**
     * SSRF pre-flight on user-supplied URLs (submit + collector). When `true`,
     * `validateSsrf()` resolves DNS and rejects private/reserved IPs before
     * submit / fetch. Defaults to `false` because Goldpan is shipped as a
     * self-hosted single-user / small-team app, and the typical user runs
     * behind a proxy (Clash / Surge / V2Ray) whose fake-IP mode resolves
     * public domains to reserved ranges (198.18.0.0/15, 100.64.0.0/10) —
     * with SSRF on, legitimate URLs would be rejected as RFC 2544 benchmark
     * space, which is a worse default UX than the marginal protection.
     *
     * Operators exposing the server to untrusted submitters should flip this
     * to `true` (it still blocks loopback / link-local / cloud metadata
     * 169.254.169.254 endpoints).
     */
    GOLDPAN_SSRF_VALIDATION_ENABLED: z.enum(['true', 'false']).default('false'),

    // Auth
    GOLDPAN_AUTH_PASSWORD: z
      .string()
      .min(8, 'GOLDPAN_AUTH_PASSWORD must be at least 8 characters')
      .refine((s) => s.trim().length > 0, 'must not be whitespace-only')
      .optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Provider API Keys — format validation only, not exposed in GoldpanConfig
    // AI SDK reads these directly from process.env
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    DEEPSEEK_API_KEY: z.string().optional(),
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.url().optional(),
    DEEPSEEK_BASE_URL: z.url().optional(),
    OLLAMA_BASE_URL: z.url().default('http://localhost:11434/v1'),
    OPENROUTER_BASE_URL: z.url().optional(),
    /**
     * Explicit opt-in for Ollama. Default `false` keeps it out of the Pipeline
     * provider dropdown for users who don't run a local Ollama daemon —
     * previously it was always listed (因为 builtin 列表硬编码), 给用户造成困惑。
     * Set to `true` to surface ollama as an available provider.
     */
    GOLDPAN_OLLAMA_ENABLED: z.enum(['true', 'false']).default('false'),
  })
  .loose();

export interface GoldpanConfig {
  llm: {
    classifier: string;
    extractor: string;
    matcher: string;
    comparator: string;
    verifier?: string;
    verifierEnabled: boolean;
    intent: string;
    query: string;
    relator?: string;
    digestSummary: string;
    digestAction: string;
    /**
     * Resolved model for the `translating` pipeline step. Present only when
     * `translation.translatePipelineOutput === true`; otherwise the step is
     * skipped entirely so the model id is not loaded.
     */
    translator?: string;
  };
  /**
   * Per-step provider options forwarded to Vercel AI SDK as
   * `providerOptions[<provider>]`. Populated from
   * `GOLDPAN_LLM_<STEP>_<PROVIDER>_OPTIONS` env vars (JSON object content).
   *
   * Used by the LLM registry to wrap each step's model with
   * `defaultSettingsMiddleware`. Only the entry matching the step's resolved
   * model provider is applied at request time; mismatched entries are kept
   * (warned at load) so users can preset multi-provider configs.
   */
  llmProviderOptions: Partial<
    Record<StepWithOptions, Partial<Record<ProviderWithOptions, Record<string, unknown>>>>
  >;
  embedding: {
    enabled: boolean;
    model: string;
    dimensions: number;
    batchSize: number;
  };
  workerInterval: number;
  collectTimeout: number;
  /** Passed to plugins (collector-browser): auto | bundled | system-chrome */
  browserStrategy: 'auto' | 'bundled' | 'system-chrome';
  /** 视频 collector 整体超时（秒），独立于 collectTimeout */
  mediaCollectTimeout: number;
  /** yt-dlp 自动检查更新；关闭后只用本地 PINNED */
  ytDlpAutoUpdate: boolean;
  /** 钉死特定 yt-dlp 版本 */
  ytDlpVersion: string | undefined;
  /** 外部 yt-dlp binary 路径（跳过下载） */
  ytDlpBinaryPath: string | undefined;
  /** binary + version.txt 存放目录（默认 ${dataDir}/yt-dlp） */
  ytDlpDir: string | undefined;
  /** GitHub latest 查询缓存（小时） */
  ytDlpUpdateCheckIntervalH: number;
  /** yt-dlp cookies.txt 路径 */
  ytDlpCookiesPath: string | undefined;
  /**
   * Global default LLM call timeout (seconds). Used when a step has no
   * per-step override in {@link GoldpanConfig.llmStepTimeouts}.
   */
  llmTimeout: number;
  /**
   * Per-step LLM timeout overrides (seconds). Populated from
   * `GOLDPAN_LLM_<STEP>_TIMEOUT` env vars; unset steps are absent from this
   * record and fall back to `llmTimeout`. Resolve via {@link resolveStepTimeout}.
   */
  llmStepTimeouts: Partial<Record<StepWithOptions, number>>;
  outputFullThreshold: number;
  outputIncrementThreshold: number;
  maxTextInputLength: number;
  maxContentLength: number;
  /** Minimum collected/pasted content length (chars) to feed the pipeline; below this the collecting step fails with errorKind `content_length`. */
  minContentLength: number;
  /** 0 = send full input to intent classifier; >0 = truncate to this many chars */
  intentClassificationCharLimit: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  llmLogPayloads: boolean;
  db: {
    type: 'sqlite' | 'postgresql';
    sqlitePath: string;
    url?: string;
  };
  providerBaseUrls: {
    /** Optional: forwarded to `createOpenAI({ baseURL })` only when set. Unset = SDK default. */
    openai?: string;
    /** Optional: forwarded to `createDeepSeek({ baseURL })` only when set. Unset = SDK default `https://api.deepseek.com`. */
    deepseek?: string;
    ollama: string;
    /** Optional: forwarded to `createOpenAICompatible({ baseURL })`. Unset = SDK default `https://openrouter.ai/api/v1`. */
    openrouter?: string;
  };
  /**
   * `true` when user opted into Ollama via `GOLDPAN_OLLAMA_ENABLED=true`.
   * Settings UI and the `/llm/providers` snapshot use this to decide whether
   * to surface ollama in the Pipeline provider dropdown — local-inference has
   * no API-key concept, so we can't reuse the env-key-presence heuristic that
   * gates the other builtins.
   */
  ollamaEnabled: boolean;
  language: 'en' | 'zh';
  /**
   * Optional post-processing translation of pipeline outputs into `language`.
   * When `translatePipelineOutput === true`, the translating step runs after
   * verifying and writes translated copies into the *_translated DB columns
   * alongside the originals (originals are never overwritten). UI consumers
   * default to translated text and offer a toggle back to original.
   */
  translation: {
    translatePipelineOutput: boolean;
  };
  /**
   * IANA timezone string (e.g. `Asia/Shanghai`, `Etc/GMT-8`). Source of truth
   * for every "local time" decision in the server process (digest scheduler,
   * tracking rule windows, audit log timestamps). Defaults to host-detected via
   * `detectHostTimezone()` (`process.env.TZ` → `Intl` → `UTC` fallback).
   */
  timezone: string;
  /** Standalone server: HTTP socket idle timeout (ms). 0 = disabled (Node default). */
  serverSocketTimeoutMs: number;
  /** Trust proxy X-Forwarded-For for rate-limit keying. Only for servers behind a trusted reverse proxy. */
  trustProxy: boolean;
  /**
   * SSRF pre-flight on user-supplied URLs. `true` = `validateSsrf()` runs
   * before submit / fetch; `false` (default) = skip entirely. Defaults to
   * off because the typical self-host runs behind a proxy whose fake-IP
   * mode maps public domains into reserved ranges — with SSRF on those
   * legitimate URLs get rejected. Flip on when exposing to untrusted
   * submitters.
   */
  ssrfValidationEnabled: boolean;
  authPassword?: string;
  nodeEnv: 'development' | 'test' | 'production';
  relation: {
    enabled: boolean;
  };
  tracking: {
    schedulerEnabled: boolean;
  };
  digest: {
    enabled: boolean;
    dailyTime: string;
    maxItemsPerModule: number;
    linkSigningKey?: string;
    linkTtlDays: number;
    publicBaseUrl?: string;
  };
  /**
   * IM runtime knobs that apply across all channels. Channel-specific config
   * (Telegram bot tokens, Feishu app IDs, etc.) is owned by each plugin's
   * `goldpanIMEnvSpec` and parsed by the server's `loadImChannelConfigs`.
   */
  im: {
    conversationWindowSize: number;
    conversationTtlDays: number;
    dedupeTtlHours: number;
    dedupePurgeIntervalMinutes: number;
  };
  /**
   * User-defined OpenAI-compatible providers parsed from
   * `GOLDPAN_LLM_PROVIDER_<ID>_BASE_URL` / `_API_KEY_ENV` env pairs. Empty
   * array when none configured. See `parseCustomLlmProviders` for the schema.
   */
  customLlmProviders: CustomLlmProvider[];
  /**
   * 用户预录的 model 列表，按 provider id 分组。来源是
   * `GOLDPAN_LLM_PROVIDER_<ID>_MODELS` env（builtin / custom / plugin 共用同一
   * 命名约定），外加 ollama 的兼容 fallback `GOLDPAN_OLLAMA_MODELS`（见 loadConfig
   * 里的 merge 逻辑）。Settings UI 用这个 map 在 Provider 页让用户为每个 provider
   * 编辑模型清单，Pipeline 页下拉从同一个数据源读 —— 不再有前端 hardcode 的默认
   * 列表，全部由用户在 Provider 页自行管理。
   *
   * 缺省值（用户没填）就是 map 里没有这个 key —— 前端走「自定义输入」退路。
   */
  providerModels: Record<string, string[]>;
  /**
   * 用户标记为 embedding 角色的 model 列表，按 provider id 分组。来源是
   * `GOLDPAN_LLM_PROVIDER_<ID>_EMBEDDING_MODELS` env。和 `providerModels` 互斥
   * 维护：chat 和 embedding 在真实模型层面集合互斥（`gpt-4o` 没 embedding
   * endpoint、`text-embedding-3-small` 没 chat endpoint），分两份让 Pipeline 下
   * 拉只看 chat、Embedding 设置只看 embedding，user 选错的可能性最小化。
   *
   * 缺省值（用户没填）就是 map 里没有这个 key —— Embedding 设置 / onboarding
   * 的 embedding model 下拉为空 + 提示用户去 Provider 页加 embedding model。
   */
  providerEmbeddingModels: Record<string, string[]>;
}

/**
 * Walk up from this source file looking for pnpm-workspace.yaml to find the
 * monorepo root.  Falls back to process.cwd() — correct for Docker where
 * WORKDIR is already the project root.
 */
export function resolveProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const { root } = path.parse(dir);
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/**
 * `envOverride` lets callers (e.g. settings UI test endpoints) parse a snapshot
 * of env that includes `.env` file values written after process startup.
 * Default `process.env` preserves the standard behavior at bootstrap and across
 * the codebase.
 */
export function loadConfig(envOverride: NodeJS.ProcessEnv = process.env): GoldpanConfig {
  const parsed = envSchema.parse(envOverride);
  const customLlmProviders = parseCustomLlmProviders(envOverride);
  const providerModels = parseProviderModels(envOverride);
  const providerEmbeddingModels = parseProviderEmbeddingModels(envOverride);

  // V1: reject postgresql
  if (parsed.GOLDPAN_DB_TYPE === 'postgresql') {
    throw new Error('V1 only supports sqlite. PostgreSQL support is planned for a future version.');
  }

  // Cross-field messages are user-facing (surfaced inline in Settings on commit),
  // so phrase them in UI field-label terms, not raw GOLDPAN_* env keys. The two
  // content-length rules also carry a `code` — they gate user-editable hot fields,
  // so the settings UI localizes them by code (the message is the readable
  // English fallback). See `localizeCommitError` in settings-shell.tsx.

  // Threshold ordering: full ≤ increment (otherwise determineOutputMode produces wrong results)
  if (parsed.GOLDPAN_OUTPUT_FULL_THRESHOLD > parsed.GOLDPAN_OUTPUT_INCREMENT_THRESHOLD) {
    throw new Error(
      `Output full threshold (${parsed.GOLDPAN_OUTPUT_FULL_THRESHOLD}) must be ≤ output increment threshold (${parsed.GOLDPAN_OUTPUT_INCREMENT_THRESHOLD})`,
    );
  }

  if (parsed.GOLDPAN_MAX_TEXT_INPUT_LENGTH > parsed.GOLDPAN_MAX_CONTENT_LENGTH) {
    throw Object.assign(
      new Error(
        `Max pasted-text length (${parsed.GOLDPAN_MAX_TEXT_INPUT_LENGTH}) must not exceed max content length (${parsed.GOLDPAN_MAX_CONTENT_LENGTH})`,
      ),
      { code: 'content_length_text_exceeds_max' },
    );
  }

  if (parsed.GOLDPAN_MIN_CONTENT_LENGTH > parsed.GOLDPAN_MAX_CONTENT_LENGTH) {
    throw Object.assign(
      new Error(
        `Min content length (${parsed.GOLDPAN_MIN_CONTENT_LENGTH}) must not exceed max content length (${parsed.GOLDPAN_MAX_CONTENT_LENGTH})`,
      ),
      { code: 'content_length_min_exceeds_max' },
    );
  }

  // Intent classification char limit must not exceed text input length (truncation would never fire)
  if (
    parsed.GOLDPAN_INTENT_CLASSIFICATION_CHAR_LIMIT > 0 &&
    parsed.GOLDPAN_INTENT_CLASSIFICATION_CHAR_LIMIT > parsed.GOLDPAN_MAX_TEXT_INPUT_LENGTH
  ) {
    throw new Error(
      `Intent classification char limit (${parsed.GOLDPAN_INTENT_CLASSIFICATION_CHAR_LIMIT}) must be ≤ max pasted-text length (${parsed.GOLDPAN_MAX_TEXT_INPUT_LENGTH}) when set (> 0)`,
    );
  }

  // Validate verifier model format only when enabled
  if (parsed.GOLDPAN_LLM_VERIFIER_ENABLED === 'true') {
    const vResult = modelIdSchema.safeParse(parsed.GOLDPAN_LLM_VERIFIER);
    if (!vResult.success) {
      throw new Error(
        `GOLDPAN_LLM_VERIFIER must be providerId:modelId format when verifier is enabled (got "${parsed.GOLDPAN_LLM_VERIFIER}")`,
      );
    }
  }

  // Production requires auth password
  if (parsed.NODE_ENV === 'production' && !parsed.GOLDPAN_AUTH_PASSWORD) {
    throw new Error(
      'GOLDPAN_AUTH_PASSWORD is required in production. Set it in your .env or environment.',
    );
  }

  // Default llmLogPayloads based on NODE_ENV
  const llmLogPayloads =
    parsed.GOLDPAN_LLM_LOG_PAYLOADS !== undefined
      ? parsed.GOLDPAN_LLM_LOG_PAYLOADS === 'true'
      : parsed.NODE_ENV !== 'production';

  // Per-step provider options: pull from `GOLDPAN_LLM_<STEP>_<PROVIDER>_OPTIONS`
  // and warn when a step's options' provider differs from its resolved model
  // provider. Mismatched entries are still retained so users can preset
  // multi-provider configs and switch models without rewriting options.
  const stepModelIds: Record<StepWithOptions, string> = {
    classifier: parsed.GOLDPAN_LLM_CLASSIFIER,
    extractor: parsed.GOLDPAN_LLM_EXTRACTOR,
    matcher: parsed.GOLDPAN_LLM_MATCHER,
    comparator: parsed.GOLDPAN_LLM_COMPARATOR,
    verifier: parsed.GOLDPAN_LLM_VERIFIER,
    relator: parsed.GOLDPAN_LLM_RELATOR,
    translator: parsed.GOLDPAN_LLM_TRANSLATOR,
    intent: parsed.GOLDPAN_LLM_INTENT,
    query: parsed.GOLDPAN_LLM_QUERY,
    digestSummary: parsed.GOLDPAN_LLM_DIGEST_SUMMARY,
    digestAction: parsed.GOLDPAN_LLM_DIGEST_ACTION,
  };
  const parsedAsRecord = parsed as unknown as Record<string, Record<string, unknown> | undefined>;
  const llmProviderOptions: GoldpanConfig['llmProviderOptions'] = {};
  for (const step of STEPS_WITH_OPTIONS) {
    const stepEntries: Partial<Record<ProviderWithOptions, Record<string, unknown>>> = {};
    for (const provider of PROVIDERS_WITH_OPTIONS) {
      const envKey = `GOLDPAN_LLM_${STEP_ENV_SEGMENT[step]}_${provider.toUpperCase()}_OPTIONS`;
      const value = parsedAsRecord[envKey];
      if (!value || Object.keys(value).length === 0) continue;
      stepEntries[provider] = value;
    }
    if (Object.keys(stepEntries).length === 0) continue;

    const modelId = stepModelIds[step];
    const colonIdx = modelId.indexOf(':');
    const modelProvider = colonIdx > 0 ? modelId.slice(0, colonIdx) : '';
    for (const optsProvider of Object.keys(stepEntries) as ProviderWithOptions[]) {
      if (optsProvider !== modelProvider) {
        console.warn(
          `[goldpan] GOLDPAN_LLM_${STEP_ENV_SEGMENT[step]}_${optsProvider.toUpperCase()}_OPTIONS ` +
            `is set, but step "${step}" uses model from "${modelProvider}". The options will be ` +
            `ignored for the current model.`,
        );
      }
    }

    llmProviderOptions[step] = stepEntries;
  }

  return {
    llm: {
      classifier: parsed.GOLDPAN_LLM_CLASSIFIER,
      extractor: parsed.GOLDPAN_LLM_EXTRACTOR,
      matcher: parsed.GOLDPAN_LLM_MATCHER,
      comparator: parsed.GOLDPAN_LLM_COMPARATOR,
      verifier:
        parsed.GOLDPAN_LLM_VERIFIER_ENABLED === 'true' ? parsed.GOLDPAN_LLM_VERIFIER : undefined,
      verifierEnabled: parsed.GOLDPAN_LLM_VERIFIER_ENABLED === 'true',
      intent: parsed.GOLDPAN_LLM_INTENT,
      query: parsed.GOLDPAN_LLM_QUERY,
      relator: parsed.GOLDPAN_RELATION_ENABLED === 'true' ? parsed.GOLDPAN_LLM_RELATOR : undefined,
      digestSummary: parsed.GOLDPAN_LLM_DIGEST_SUMMARY,
      digestAction: parsed.GOLDPAN_LLM_DIGEST_ACTION,
      translator:
        parsed.GOLDPAN_TRANSLATE_PIPELINE_OUTPUT === 'true'
          ? parsed.GOLDPAN_LLM_TRANSLATOR
          : undefined,
    },
    llmProviderOptions,
    llmStepTimeouts: (() => {
      const out: Partial<Record<StepWithOptions, number>> = {};
      for (const step of STEPS_WITH_OPTIONS) {
        const v = parsedAsRecord[stepTimeoutEnvKey(step)] as unknown as number | undefined;
        if (typeof v === 'number') out[step] = v;
      }
      return out;
    })(),
    embedding: {
      enabled: parsed.GOLDPAN_EMBEDDING_ENABLED === 'true',
      model: parsed.GOLDPAN_EMBEDDING_MODEL,
      dimensions: parsed.GOLDPAN_EMBEDDING_DIMENSIONS,
      batchSize: parsed.GOLDPAN_EMBEDDING_BATCH_SIZE,
    },
    workerInterval: parsed.GOLDPAN_WORKER_INTERVAL,
    collectTimeout: parsed.GOLDPAN_COLLECT_TIMEOUT,
    browserStrategy: parsed.GOLDPAN_BROWSER_STRATEGY,
    mediaCollectTimeout: parsed.GOLDPAN_MEDIA_COLLECT_TIMEOUT,
    ytDlpAutoUpdate: parsed.GOLDPAN_YT_DLP_AUTO_UPDATE === 'true',
    ytDlpVersion: parsed.GOLDPAN_YT_DLP_VERSION,
    ytDlpBinaryPath: parsed.GOLDPAN_YT_DLP_BINARY_PATH,
    ytDlpDir: parsed.GOLDPAN_YT_DLP_DIR,
    ytDlpUpdateCheckIntervalH: parsed.GOLDPAN_YT_DLP_UPDATE_CHECK_INTERVAL_H,
    ytDlpCookiesPath: parsed.GOLDPAN_YT_DLP_COOKIES_PATH,
    llmTimeout: parsed.GOLDPAN_LLM_TIMEOUT,
    outputFullThreshold: parsed.GOLDPAN_OUTPUT_FULL_THRESHOLD,
    outputIncrementThreshold: parsed.GOLDPAN_OUTPUT_INCREMENT_THRESHOLD,
    maxTextInputLength: parsed.GOLDPAN_MAX_TEXT_INPUT_LENGTH,
    maxContentLength: parsed.GOLDPAN_MAX_CONTENT_LENGTH,
    minContentLength: parsed.GOLDPAN_MIN_CONTENT_LENGTH,
    intentClassificationCharLimit: parsed.GOLDPAN_INTENT_CLASSIFICATION_CHAR_LIMIT,
    logLevel: parsed.GOLDPAN_LOG_LEVEL,
    llmLogPayloads,
    db: {
      type: parsed.GOLDPAN_DB_TYPE,
      sqlitePath: path.isAbsolute(parsed.GOLDPAN_DB_SQLITE_PATH)
        ? parsed.GOLDPAN_DB_SQLITE_PATH
        : path.resolve(resolveProjectRoot(), parsed.GOLDPAN_DB_SQLITE_PATH),
      url: parsed.GOLDPAN_DB_URL,
    },
    providerBaseUrls: {
      openai: parsed.OPENAI_BASE_URL,
      deepseek: parsed.DEEPSEEK_BASE_URL,
      ollama: parsed.OLLAMA_BASE_URL,
      openrouter: parsed.OPENROUTER_BASE_URL,
    },
    ollamaEnabled: parsed.GOLDPAN_OLLAMA_ENABLED === 'true',
    language: parsed.GOLDPAN_LANGUAGE,
    translation: {
      translatePipelineOutput: parsed.GOLDPAN_TRANSLATE_PIPELINE_OUTPUT === 'true',
    },
    timezone: parsed.GOLDPAN_TIMEZONE,
    serverSocketTimeoutMs: parsed.GOLDPAN_SERVER_SOCKET_TIMEOUT_MS,
    trustProxy: parsed.GOLDPAN_TRUST_PROXY === 'true' || parsed.GOLDPAN_TRUST_PROXY === '1',
    ssrfValidationEnabled: parsed.GOLDPAN_SSRF_VALIDATION_ENABLED === 'true',
    authPassword: parsed.GOLDPAN_AUTH_PASSWORD,
    nodeEnv: parsed.NODE_ENV,
    relation: {
      enabled: parsed.GOLDPAN_RELATION_ENABLED === 'true',
    },
    tracking: {
      schedulerEnabled: parsed.GOLDPAN_TRACKING_SCHEDULER_ENABLED === 'true',
    },
    digest: {
      enabled: parsed.GOLDPAN_DIGEST_ENABLED === 'true',
      dailyTime: parsed.GOLDPAN_DIGEST_DAILY_TIME,
      maxItemsPerModule: parsed.GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE,
      linkSigningKey: parsed.GOLDPAN_DIGEST_LINK_SIGNING_KEY,
      linkTtlDays: parsed.GOLDPAN_DIGEST_LINK_TTL_DAYS,
      publicBaseUrl: parsed.GOLDPAN_DIGEST_PUBLIC_BASE_URL,
    },
    im: {
      conversationWindowSize: parsed.GOLDPAN_IM_CONVERSATION_WINDOW_SIZE,
      conversationTtlDays: parsed.GOLDPAN_IM_CONVERSATION_TTL_DAYS,
      dedupeTtlHours: parsed.GOLDPAN_IM_DEDUPE_TTL_HOURS,
      dedupePurgeIntervalMinutes: parsed.GOLDPAN_IM_DEDUPE_PURGE_INTERVAL_MINUTES,
    },
    customLlmProviders,
    providerModels,
    providerEmbeddingModels,
  };
}

/**
 * Resolve the effective timeout (seconds) for one LLM step: per-step override
 * if set via `GOLDPAN_LLM_<STEP>_TIMEOUT`, else the global `llmTimeout`.
 *
 * Centralized so every call site (pipeline steps, intent/query, plugin
 * service-callLlm wrapper) shares one resolution rule — adding a new override
 * env never requires touching consumers.
 */
export function resolveStepTimeout(config: GoldpanConfig, step: StepWithOptions): number {
  return config.llmStepTimeouts[step] ?? config.llmTimeout;
}

/**
 * Managed env keys that **cannot** hot-reload via `ConfigStore.commit`, even
 * though commit writes them to DB + applies them to `process.env`. Each one is
 * read at boot by code paths that don't watch the snapshot:
 *
 * - `GOLDPAN_AUTH_PASSWORD`: `apps/server/main.ts` captures
 *   `handle.config.authPassword` once for every request's auth gate from the
 *   boot snapshot, so server's enforcement is frozen until the server process
 *   restarts. (Web no longer needs its own restart — it queries server's
 *   `/auth/status` per request via `apps/web/src/lib/auth-probe.ts`, so any
 *   web-side "is auth required?" decision stays in sync with whatever the
 *   server enforces. That's why this key is in `STATIC_RESTART_REQUIRED_KEYS`
 *   below but NOT in `DUAL_PROCESS_RESTART_KEYS` further down.)
 * - `GOLDPAN_LANGUAGE`: server's `initI18n` runs once at boot, web's
 *   `apps/web/src/i18n/request.ts` reads `process.env.GOLDPAN_LANGUAGE` per
 *   request from the web process's frozen env. Plus `resolveLanguageLock`
 *   may further pin language at first-data, so even after restart it can
 *   refuse to change.
 * - `GOLDPAN_WEB_ENABLED`: gates whether the web container starts at all
 *   (consumed by docker / supervisor wiring outside Node).
 * - `GOLDPAN_DIGEST_ENABLED`: digest 调度器在 plugin postInit 阶段一次性
 *   spin up（`plugins/digest/src/index.ts` createDataSnapshotScheduler /
 *   createPushScheduler），后续 `/digest/*` 路由全部走 `handle.config.digest.*`
 *   frozen 快照。从 false → true 不会拉起调度器，从 true → false 不会停。
 * - `GOLDPAN_TRACKING_SCHEDULER_ENABLED`: `bootstrap.ts` 在 `effectiveConfig
 *   .tracking.schedulerEnabled` 为真时启动 tracking scheduler，关掉/打开都
 *   只在重启时才生效。
 * - `GOLDPAN_EMBEDDING_ENABLED`: bootstrap 一次性 load `sqlite-vec`、
 *   `ensureVecTables`、跑 `backfillEmbeddings`。运行期翻这个开关既不会装
 *   sqlite-vec extension，也不会触发 backfill，必须重启。
 * - `GOLDPAN_EMBEDDING_MODEL` / `GOLDPAN_EMBEDDING_DIMENSIONS` /
 *   `GOLDPAN_EMBEDDING_BATCH_SIZE`: bootstrap 在 `loadVecExtension` 后
 *   一次性 probe embedding 维度并建出 vec0 虚拟表，后续 backfill / hybrid
 *   search 全部固化到 boot 时的 dimensions。运行期改 model / dimensions
 *   会让向量列与已写入数据不一致，必须重启重建表。
 * - `GOLDPAN_IM_TELEGRAM_*` / `GOLDPAN_IM_FEISHU_*`（每个 channel 的
 *   bot token / app id / app secret / encrypt key / domain / 知识库 URL
 *   模板 / enabled）：IM channel 在 `composeIMRuntime` 里通过 plugin
 *   manifest 一次性注册并启动 long-poll / webhook 监听。运行期改这些值
 *   既不会重启 grammy bot 也不会重新注册 webhook。新加 / 切换 channel
 *   都必须重启 server。
 *
 * `apps/server/src/routes/settings.ts` returns these in `pendingRestartKeys`
 * so the UI (PR2) can warn the user that a restart of BOTH server and web
 * is needed for them to take effect. Wizard `/onboarding/commit` doesn't need
 * to surface the list — wizard always restarts immediately, but the same
 * "web also needs restart" caveat still applies and is documented in the
 * onboarding `completed_subtitle` copy.
 *
 * Still out-of-scope（仍然 boot-only，但目前 PR2 不纳入此白名单）：调度
 * 参数类（`GOLDPAN_DIGEST_DAILY_TIME` / `GOLDPAN_TRACKING_POLL_INTERVAL` / etc.）
 * 由 PR2 plugin 热更迁移负责（tracking / digest scheduler 改成每 tick 重读
 * 最新 snapshot），不再需要重启。其它参数类调整通常伴随 enable，已在白
 * 名单内。
 */
export const STATIC_RESTART_REQUIRED_KEYS: ReadonlyArray<string> = [
  'GOLDPAN_AUTH_PASSWORD',
  'GOLDPAN_LANGUAGE',
  'GOLDPAN_TIMEZONE',
  'GOLDPAN_WEB_ENABLED',
  'GOLDPAN_SSRF_VALIDATION_ENABLED',
  'GOLDPAN_DIGEST_ENABLED',
  'GOLDPAN_TRACKING_SCHEDULER_ENABLED',
  'GOLDPAN_EMBEDDING_ENABLED',
  'GOLDPAN_EMBEDDING_MODEL',
  'GOLDPAN_EMBEDDING_DIMENSIONS',
  'GOLDPAN_EMBEDDING_BATCH_SIZE',
  'GOLDPAN_IM_TELEGRAM_BOT_TOKEN',
  'GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS',
  'GOLDPAN_IM_TELEGRAM_ENABLED',
  'GOLDPAN_IM_FEISHU_APP_ID',
  'GOLDPAN_IM_FEISHU_APP_SECRET',
  'GOLDPAN_IM_FEISHU_ENCRYPT_KEY',
  'GOLDPAN_IM_FEISHU_DOMAIN',
  'GOLDPAN_IM_FEISHU_ENABLED',
  'GOLDPAN_COLLECT_TIMEOUT',
  'GOLDPAN_BROWSER_STRATEGY',
  'GOLDPAN_BROWSER_EXECUTABLE_PATH',
  'GOLDPAN_MEDIA_COLLECT_TIMEOUT',
  'GOLDPAN_YT_DLP_AUTO_UPDATE',
  'GOLDPAN_YT_DLP_BINARY_PATH',
  'GOLDPAN_YT_DLP_COOKIES_PATH',
  'GOLDPAN_GITHUB_TOKEN',
] as const;

const STATIC_RESTART_REQUIRED_SET: ReadonlySet<string> = new Set(STATIC_RESTART_REQUIRED_KEYS);

/** Test if a managed key requires a restart for its committed value to take effect. */
export function isStaticRestartRequiredKey(key: string): boolean {
  return STATIC_RESTART_REQUIRED_SET.has(key);
}

/**
 * Subset of restart-required keys that ALSO affect the Web (Next.js) process,
 * not just the server. UI must warn the user that BOTH services need a restart.
 *
 * Authoritative source — `web-sdk/src/types.ts` mirrors this list with a sync
 * test (`packages/web-sdk/tests/dual-process-restart-keys-sync.test.ts`),
 * matching the pattern used by MANAGED_ENV_KEYS.
 *
 *  - GOLDPAN_LANGUAGE: i18n/request.ts (next-intl) reads per-request from
 *    `process.env.GOLDPAN_LANGUAGE`, which the web Node process freezes at boot
 *    (no ConfigStore in web). Server's i18n is also boot-frozen.
 *
 * GOLDPAN_AUTH_PASSWORD was here historically, removed once web stopped
 * reading its own env for auth and started querying server's `/auth/status`
 * per request (see `apps/web/src/lib/auth-probe.ts`). Password change still
 * needs a server restart (per `STATIC_RESTART_REQUIRED_KEYS` above) but no
 * longer a web one, so the "BOTH" warning was over-broad.
 */
export const DUAL_PROCESS_RESTART_KEYS: ReadonlyArray<string> = ['GOLDPAN_LANGUAGE'] as const;

export type LenientResult =
  | { ok: true; parsed: z.infer<typeof envSchema> }
  | { ok: false; errors: z.core.$ZodIssue[] };

/**
 * Wizard-mode config loader: runs `envSchema.parse()` (format validation,
 * including modelId / time / JSON-object shapes) but SKIPS the cross-field
 * business rules below. Wizard UI surfaces format errors so the user can fix
 * them, but production-requires-password / threshold-ordering / postgresql-
 * rejection / verifier-model-format are all enforced at strict `loadConfig()`
 * time after wizard commits and the server restarts in normal mode.
 *
 * Accepts an explicit `env` arg so wizard can validate staged keys without
 * mutating `process.env`. Defaults to `process.env` for parity with strict.
 */
export function lenientLoadConfig(env: NodeJS.ProcessEnv = process.env): LenientResult {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    return { ok: false, errors: result.error.issues };
  }
  return { ok: true, parsed: result.data };
}

export type { CreateConfigStoreOptions } from './store';
export { createConfigStore } from './store';
export type {
  CommitOptions,
  CommitResult,
  ConfigOrigin,
  ConfigPatch,
  ConfigSnapshot,
  ConfigStore,
  SnapshotListener,
  WizardCommitResult,
} from './store-types';
export type { ValidateStagedInput, ValidateStagedResult } from './validate-staged';
export { stripNulls, validateStaged } from './validate-staged';
export type { WizardCommitOptions } from './wizard-commit';
export { commitWizardOverrides } from './wizard-commit';
