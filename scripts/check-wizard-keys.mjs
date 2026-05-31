#!/usr/bin/env node
/**
 * Soft consistency check between `envSchema` (config/index.ts) and the wizard's
 * `MANAGED_ENV_KEYS` (onboarding/env-file.ts). Each `GOLDPAN_*` /
 * provider-key field declared in envSchema should be either:
 *
 *   1. listed in `MANAGED_ENV_KEYS` (so writeEnvFile preserves the user's
 *      hand-edits in unmanaged territory + wizard owns the managed keys), OR
 *   2. intentionally excluded — typically operator-only knobs (logs, debug
 *      flags) that don't belong in a UI.
 *
 * The check is a soft warning, not a hard failure. CI surfaces drift, the
 * maintainer decides whether the new key needs a wizard surface or whether to
 * silence by adding to the explicit allowlist below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const configPath = path.join(repoRoot, 'packages/core/src/config/index.ts');
const onboardingPath = path.join(repoRoot, 'packages/core/src/onboarding/env-file.ts');

const KEY_PATTERN =
  /\b(GOLDPAN_[A-Z0-9][A-Z0-9_]*[A-Z0-9]|OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|TAVILY_API_KEY|SERPER_API_KEY|OPENAI_BASE_URL|DEEPSEEK_BASE_URL|OLLAMA_BASE_URL)\b/g;

/**
 * Operator-only / advanced env keys that intentionally don't appear in the
 * wizard. Add here when introducing a new envSchema field that's not a
 * candidate for the UI (logs / dev-only / probe overrides / etc).
 */
const INTENTIONALLY_UNMANAGED = new Set([
  // Logs / debug / dev knobs
  'GOLDPAN_LOG_LEVEL',
  'GOLDPAN_LLM_LOG_PAYLOADS',
  'GOLDPAN_DEBUG_API',
  // Network / deployment knobs (set by docker / k8s / supervisor — not user choice)
  'GOLDPAN_TRUST_PROXY',
  // SSRF kill-switch — security knob for users on networks that resolve public
  // domains into reserved ranges (proxy fake-IP). Not wizard-surfaced because
  // disabling weakens server-side fetch safety; documented in .env.example.
  'GOLDPAN_SSRF_VALIDATION_ENABLED',
  'GOLDPAN_SERVER_PORT',
  'GOLDPAN_SERVER_SOCKET_TIMEOUT_MS',
  'GOLDPAN_SERVER_READY_TIMEOUT_S',
  'GOLDPAN_WEB_PORT',
  'GOLDPAN_WEB_PACKAGE',
  'GOLDPAN_SERVER_URL',
  // DB
  'GOLDPAN_DB_SQLITE_PATH',
  'GOLDPAN_DB_TYPE',
  'GOLDPAN_DB_URL',
  // Browser collector internals
  'GOLDPAN_BROWSER_STRATEGY',
  'GOLDPAN_BROWSER_EXECUTABLE_PATH',
  // Pipeline tuning (advanced; defaults are fine for most users)
  'GOLDPAN_INTENT_CLASSIFICATION_CHAR_LIMIT',
  'GOLDPAN_LLM_TIMEOUT',
  'GOLDPAN_COLLECT_TIMEOUT',
  'GOLDPAN_WORKER_INTERVAL',
  'GOLDPAN_OUTPUT_FULL_THRESHOLD',
  'GOLDPAN_OUTPUT_INCREMENT_THRESHOLD',
  'GOLDPAN_MAX_TEXT_INPUT_LENGTH',
  'GOLDPAN_MAX_CONTENT_LENGTH',
  'GOLDPAN_MIN_CONTENT_LENGTH',
  // Wizard meta — set by entrypoint scripts, not user-facing fields
  'GOLDPAN_FORCE_WIZARD',
  // Digest share-link signing (operator key + base URL — out of wizard scope)
  'GOLDPAN_DIGEST_LINK_SIGNING_KEY',
  'GOLDPAN_DIGEST_LINK_TTL_DAYS',
  'GOLDPAN_DIGEST_PUBLIC_BASE_URL',
  // IM runtime internals (TTL / window / dedupe — fine on defaults)
  'GOLDPAN_IM_CONVERSATION_TTL_DAYS',
  'GOLDPAN_IM_CONVERSATION_WINDOW_SIZE',
  'GOLDPAN_IM_DEDUPE_PURGE_INTERVAL_MINUTES',
  'GOLDPAN_IM_DEDUPE_TTL_HOURS',
  // Tracking advanced rate limits (defaults sufficient)
  'GOLDPAN_TRACKING_MIN_RULE_INTERVAL',
  'GOLDPAN_TRACKING_MAX_RESULTS_PER_SEARCH',
  // Embedding probe / backfill internals
  'GOLDPAN_EMBEDDING_BACKFILL_BATCH_SIZE',
  'GOLDPAN_EMBEDDING_BACKFILL_RATE_LIMIT_PER_MINUTE',
  // collector-media (yt-dlp 视频源) — operator-only：默认开箱可用，调优在 .env / docker
  'GOLDPAN_MEDIA_COLLECT_TIMEOUT',
  'GOLDPAN_YT_DLP_AUTO_UPDATE',
  'GOLDPAN_YT_DLP_VERSION',
  'GOLDPAN_YT_DLP_BINARY_PATH',
  'GOLDPAN_YT_DLP_DIR',
  'GOLDPAN_YT_DLP_UPDATE_CHECK_INTERVAL_H',
  'GOLDPAN_YT_DLP_COOKIES_PATH',
]);

/**
 * Patterns we treat as collectively unmanaged. Per-provider per-step option
 * blobs (e.g. `GOLDPAN_LLM_CLASSIFIER_ANTHROPIC_OPTIONS`) are JSON tunings —
 * advanced ops territory, not wizard UI fodder.
 */
const UNMANAGED_PATTERNS = [
  /^GOLDPAN_LLM_[A-Z_]+_(ANTHROPIC|OPENAI|DEEPSEEK|GOOGLE|OLLAMA)_OPTIONS$/,
  /^GOLDPAN_PROMPT_/,
];

const configSrc = fs.readFileSync(configPath, 'utf8');
const onboardingSrc = fs.readFileSync(onboardingPath, 'utf8');

const envFields = new Set([...configSrc.matchAll(KEY_PATTERN)].map((m) => m[1]));
const managed = new Set([...onboardingSrc.matchAll(KEY_PATTERN)].map((m) => m[1]));

const drift = [...envFields].filter((k) => {
  if (managed.has(k)) return false;
  if (INTENTIONALLY_UNMANAGED.has(k)) return false;
  if (UNMANAGED_PATTERNS.some((p) => p.test(k))) return false;
  return true;
});

if (drift.length === 0) {
  // Silent on success — keeps CI output clean.
  process.exit(0);
}

console.warn('[check-wizard-keys] Env vars in envSchema but not in MANAGED_ENV_KEYS:');
for (const k of drift.sort()) console.warn(`  - ${k}`);
console.warn('');
console.warn('Resolution: either');
console.warn('  (a) add to MANAGED_ENV_KEYS in packages/core/src/onboarding/env-file.ts');
console.warn('      AND surface it in the wizard UI / CLI, OR');
console.warn('  (b) add to INTENTIONALLY_UNMANAGED in scripts/check-wizard-keys.mjs');
console.warn('      with a one-line reason in your commit message.');

// Soft warning — exit 0 keeps lint passing. Make explicit by exiting cleanly.
process.exit(0);
