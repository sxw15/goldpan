import fs from 'node:fs';

export const MANAGED_ENV_KEYS = [
  'GOLDPAN_LANGUAGE',
  'GOLDPAN_TRANSLATE_PIPELINE_OUTPUT',
  'GOLDPAN_LLM_TRANSLATOR',
  'GOLDPAN_LLM_TRANSLATOR_TIMEOUT',
  'GOLDPAN_TIMEZONE',
  'GOLDPAN_WEB_ENABLED',
  'GOLDPAN_AUTH_PASSWORD',
  'GOLDPAN_SSRF_VALIDATION_ENABLED',
  'GOLDPAN_LLM_CLASSIFIER',
  'GOLDPAN_LLM_EXTRACTOR',
  'GOLDPAN_LLM_MATCHER',
  'GOLDPAN_LLM_COMPARATOR',
  'GOLDPAN_LLM_VERIFIER',
  'GOLDPAN_LLM_VERIFIER_ENABLED',
  'GOLDPAN_LLM_INTENT',
  'GOLDPAN_LLM_QUERY',
  'GOLDPAN_LLM_RELATOR',
  'GOLDPAN_RELATION_ENABLED',
  'GOLDPAN_LLM_DIGEST_SUMMARY',
  'GOLDPAN_LLM_DIGEST_ACTION',
  'GOLDPAN_LLM_TIMEOUT',
  'GOLDPAN_LLM_CLASSIFIER_TIMEOUT',
  'GOLDPAN_LLM_EXTRACTOR_TIMEOUT',
  'GOLDPAN_LLM_MATCHER_TIMEOUT',
  'GOLDPAN_LLM_COMPARATOR_TIMEOUT',
  'GOLDPAN_LLM_VERIFIER_TIMEOUT',
  'GOLDPAN_LLM_RELATOR_TIMEOUT',
  'GOLDPAN_LLM_INTENT_TIMEOUT',
  'GOLDPAN_LLM_QUERY_TIMEOUT',
  'GOLDPAN_LLM_DIGEST_SUMMARY_TIMEOUT',
  'GOLDPAN_LLM_DIGEST_ACTION_TIMEOUT',
  'GOLDPAN_DIGEST_ENABLED',
  'GOLDPAN_DIGEST_DAILY_TIME',
  'GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE',
  'GOLDPAN_TRACKING_SCHEDULER_ENABLED',
  'GOLDPAN_TRACKING_POLL_INTERVAL',
  'GOLDPAN_TRACKING_DAILY_SEARCH_LIMIT',
  'GOLDPAN_TRACKING_MIN_RULE_INTERVAL',
  'GOLDPAN_TRACKING_MAX_RESULTS_PER_SEARCH',
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
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_BASE_URL',
  'OPENAI_BASE_URL',
  'OLLAMA_BASE_URL',
  'GOLDPAN_OLLAMA_ENABLED',
  'OPENROUTER_BASE_URL',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'EXA_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'SEARXNG_BASE_URL',
  'GOLDPAN_GOOGLE_SEARCH_ENABLED',
  'GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT',
  'GOLDPAN_GOOGLE_SEARCH_DELAY_MIN_MS',
  'GOLDPAN_GOOGLE_SEARCH_DELAY_MAX_MS',
  'GOLDPAN_COLLECT_TIMEOUT',
  'GOLDPAN_BROWSER_STRATEGY',
  'GOLDPAN_BROWSER_EXECUTABLE_PATH',
  'GOLDPAN_MEDIA_COLLECT_TIMEOUT',
  'GOLDPAN_YT_DLP_AUTO_UPDATE',
  'GOLDPAN_YT_DLP_BINARY_PATH',
  'GOLDPAN_YT_DLP_COOKIES_PATH',
  'GOLDPAN_GITHUB_TOKEN',
  // Content-length limits — hot-reloadable, so deliberately NOT in
  // STATIC_RESTART_REQUIRED_KEYS. Surfaced in Settings → 引擎 / 采集 · 内容长度.
  // MAX/MIN_CONTENT's pipeline check is hot for free: the collecting step reads
  // `ctx.config`, which the orchestrator rebinds from a fresh ConfigStore
  // snapshot per task. (Caveat: the github-collector plugin reads MAX_CONTENT
  // once at init for its own truncation — plugin config is restart-bound by the
  // plugin model; the core pipeline check above stays hot.)
  // MAX_TEXT_INPUT is ALSO enforced at server entry gates (submit / input /
  // user-notes / auth-status) — those must read `configStore.getSnapshot()`,
  // NOT the frozen `handle.config`, or it silently reverts to restart-required.
  // Any NEW input entry path that caps text length must do the same live read.
  'GOLDPAN_MAX_CONTENT_LENGTH',
  'GOLDPAN_MIN_CONTENT_LENGTH',
  'GOLDPAN_MAX_TEXT_INPUT_LENGTH',
] as const;

const MANAGED_SET = new Set<string>(MANAGED_ENV_KEYS);

/**
 * Pattern-based managed-key whitelist. Used alongside the literal
 * `MANAGED_ENV_KEYS` to allow dynamic env var names that follow predictable
 * shapes — currently only custom LLM provider declarations
 * (`GOLDPAN_LLM_PROVIDER_<ID>_BASE_URL` / `_API_KEY_ENV`).
 *
 * Dynamic keys passed through `configStore.commit` rely on this whitelist —
 * see `isManagedEnvKey` for the runtime check.
 */
export const MANAGED_ENV_PATTERNS: ReadonlyArray<RegExp> = [
  /^GOLDPAN_LLM_PROVIDER_[A-Z][A-Z0-9_]*_BASE_URL$/,
  /^GOLDPAN_LLM_PROVIDER_[A-Z][A-Z0-9_]*_API_KEY_ENV$/,
  /^GOLDPAN_LLM_PROVIDER_[A-Z][A-Z0-9_]*_MODELS$/,
  // Per-step provider options (thinking / reasoning). STEP alternation mirrors
  // `STEPS_WITH_OPTIONS` and PROVIDER alternation mirrors `PROVIDERS_WITH_OPTIONS`
  // in `packages/core/src/config/index.ts` — keep both lists in sync when
  // adding a new pipeline step or builtin reasoning-capable provider. zod
  // (`llmStepProviderOptionsShape`) is the strict schema; this pattern is the
  // wider whitelist that lets runtime override commit reach the schema.
  /^GOLDPAN_LLM_(CLASSIFIER|EXTRACTOR|MATCHER|COMPARATOR|VERIFIER|RELATOR|TRANSLATOR|INTENT|QUERY|DIGEST_SUMMARY|DIGEST_ACTION)_(ANTHROPIC|OPENAI|GOOGLE|DEEPSEEK)_OPTIONS$/,
];

/**
 * Check if a key is allowed in commitEnv. Four sources, OR'd together:
 *
 * 1. Literal `MANAGED_ENV_KEYS` (existing core list)
 * 2. Plugin-declared keys (passed in by route handler from manifest)
 * 3. `MANAGED_ENV_PATTERNS` (new — dynamic GOLDPAN_LLM_PROVIDER_* shape)
 * 4. `dynamicAllowList` — patch-scoped allowlist, populated from
 *    `*_API_KEY_ENV` declarations in the same patch (a user choosing
 *    `apiKeyEnv: 'TOGETHER_API_KEY'` for their custom provider must be able
 *    to set the `TOGETHER_API_KEY` value in the same commit).
 */
export function isManagedEnvKey(
  key: string,
  pluginEnvKeys: ReadonlyArray<string> = [],
  dynamicAllowList: ReadonlyArray<string> = [],
): boolean {
  if (MANAGED_SET.has(key)) return true;
  for (const p of pluginEnvKeys) if (p === key) return true;
  for (const re of MANAGED_ENV_PATTERNS) if (re.test(key)) return true;
  for (const d of dynamicAllowList) if (d === key) return true;
  return false;
}

/**
 * Extract user-declared API-key env names from a patch. When a patch declares
 * `GOLDPAN_LLM_PROVIDER_X_API_KEY_ENV=Y`, callers should treat `Y` as managed
 * for THAT patch only — otherwise the secret value (also in the patch) would
 * be rejected as an unknown key on first save. The value is validated as a
 * proper env-var name (`[A-Z][A-Z0-9_]*`) to prevent injection of arbitrary
 * keys via crafted patch values.
 */
export function extractDynamicAllowedEnvNames(patch: ReadonlyMap<string, string>): string[] {
  const allowed: string[] = [];
  const keyEnvDeclRe = /^GOLDPAN_LLM_PROVIDER_[A-Z][A-Z0-9_]*_API_KEY_ENV$/;
  const envNameRe = /^[A-Z][A-Z0-9_]*$/;
  for (const [k, v] of patch) {
    if (keyEnvDeclRe.test(k) && envNameRe.test(v)) {
      allowed.push(v);
    }
  }
  return allowed;
}

export interface ParsedEnvFile {
  lines: string[];
  /** Index in `lines` for each MANAGED_ENV_KEY found. Non-managed keys not tracked. */
  keyToLineIdx: Map<string, number>;
  /**
   * Parsed values for each managed key found in the file. Only used to
   * reflect "what `.env` actually says" (settings UI source-detection /
   * pre-write validation) — call sites that need round-trip line
   * preservation use `keyToLineIdx` + `lines` instead.
   */
  values: Map<string, string>;
}

// Strips trailing whitespace, then unwraps a double-quoted form (handling
// `\\` then `\"` escapes, matching what dotenv / docker-compose env-file
// parsers expect). Single quotes / unbalanced quotes / inline comments fall
// through unchanged.
function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trimEnd();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

export function readEnvFile(envPath: string): ParsedEnvFile {
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return { lines: [], keyToLineIdx: new Map(), values: new Map() };
  }
  const lines = raw.split('\n');
  // Last newline produces an empty trailing element — drop it for round-trip cleanness.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const keyToLineIdx = new Map<string, number>();
  const values = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    // Track literal MANAGED_ENV_KEYS plus dynamic-shape keys
    // (`GOLDPAN_LLM_PROVIDER_<ID>_BASE_URL` / `_API_KEY_ENV`). Dynamic keys
    // saved on a previous patch must round-trip when the file is re-read for
    // env-state masking / commit verification, otherwise the settings UI
    // would forget about custom providers across server restarts.
    // Plugin-declared keys are NOT pulled in here — the route layer threads
    // them through `pluginEnvKeys` for env-state listing; this file's
    // values map only owns shapes core can recognize without context.
    if (isManagedEnvKey(key)) {
      keyToLineIdx.set(key, i);
      values.set(key, parseEnvValue(line.slice(eq + 1)));
    }
  }
  return { lines, keyToLineIdx, values };
}
