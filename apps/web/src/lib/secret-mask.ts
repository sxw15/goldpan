/**
 * Client-side secret redaction shared by onboarding's SecretRedactedCard and
 * settings' EnvFallbackModal.
 *
 * The server has its own secret-detection (`SECRET_SUFFIX_RE` in
 * `apps/server/src/routes/settings.ts`) for `/settings/env-state` masks; this
 * client list only kicks in when we render raw `.env` text in the browser
 * (onboarding F8 staging summary, settings write-back fallback).
 *
 * Keep in sync with `apps/server/src/routes/onboarding/commit.ts`'s
 * `stateToEnvKeys` and any new secret-bearing keys added to MANAGED_ENV_KEYS.
 */
export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  'GOLDPAN_AUTH_PASSWORD',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'EXA_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'GOLDPAN_IM_TELEGRAM_BOT_TOKEN',
  'GOLDPAN_IM_FEISHU_APP_SECRET',
  'GOLDPAN_IM_FEISHU_ENCRYPT_KEY',
]);

/**
 * Suffix-based fallback for keys not registered in `SECRET_ENV_KEYS` ahead of
 * time. Custom-provider env vars chosen by the user at runtime (e.g.
 * `TOGETHER_API_KEY`, `GROQ_API_KEY` declared via
 * `GOLDPAN_LLM_PROVIDER_X_API_KEY_ENV=TOGETHER_API_KEY`) follow the
 * KEY/TOKEN/SECRET/PASSWORD-suffix convention but cannot be pre-registered —
 * we only know the name after the user types it. Mirrors the server-side
 * `SECRET_SUFFIX_RE` in `apps/server/src/routes/settings.ts` so masking is
 * consistent on both sides of the boundary.
 */
const SECRET_SUFFIX_RE = /(?:KEY|TOKEN|SECRET|PASSWORD)$/;

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEYS.has(key) || SECRET_SUFFIX_RE.test(key);
}

export function redactSecret(value: string): string {
  if (value.length === 0) return '';
  if (value.length <= 6) return '••••••';
  return `${value.slice(0, 3)}••••••${value.slice(-3)}`;
}

/**
 * Render `.env` text with secret values redacted line-by-line.
 *
 * Preserves comments, blank lines, and unrecognized lines verbatim. Only
 * lines matching `KEY=VALUE` where `isSecretEnvKey(KEY)` get the value
 * replaced. Surrounding quotes (single or double) are stripped before the
 * length check so a 6-char `"abc"` doesn't get treated as 5 chars and
 * over-bullet, then the redacted value goes back without quotes.
 */
export function redactEnvFile(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!m) return line;
      const key = m[1];
      if (!isSecretEnvKey(key)) return line;
      const raw = m[2];
      const unquoted =
        (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw;
      return `${key}=${redactSecret(unquoted)}`;
    })
    .join('\n');
}
