import { describe, expect, test } from 'vitest';
import { isSecretEnvKey, redactEnvFile, redactSecret, SECRET_ENV_KEYS } from './secret-mask';

describe('redactSecret', () => {
  test('empty string stays empty', () => {
    expect(redactSecret('')).toBe('');
  });

  test('short values become full bullets', () => {
    expect(redactSecret('abc')).toBe('••••••');
    expect(redactSecret('abcdef')).toBe('••••••');
  });

  test('long values keep first 3 + last 3', () => {
    expect(redactSecret('sk-proj-1234567890ABCDEF')).toBe('sk-••••••DEF');
  });
});

describe('redactEnvFile', () => {
  test('preserves comments and blank lines verbatim', () => {
    const input = '# comment\n\nGOLDPAN_LANGUAGE=zh\n# another\n';
    expect(redactEnvFile(input)).toBe(input);
  });

  test('redacts known secret keys', () => {
    const input = [
      'GOLDPAN_LANGUAGE=zh',
      'OPENAI_API_KEY=sk-proj-1234567890ABCDEF',
      'GOLDPAN_AUTH_PASSWORD=hunter', // exactly 6 chars → all-bullet branch
      'TAVILY_API_KEY=tvly-1234567890',
      '',
    ].join('\n');
    const out = redactEnvFile(input);
    expect(out).toContain('GOLDPAN_LANGUAGE=zh'); // non-secret untouched
    expect(out).toContain('OPENAI_API_KEY=sk-••••••DEF');
    expect(out).toContain('GOLDPAN_AUTH_PASSWORD=••••••'); // 6 chars → full bullets
    expect(out).toContain('TAVILY_API_KEY=tvl••••••890');
    expect(out).not.toContain('hunter');
    expect(out).not.toContain('1234567890ABCDEF');
  });

  test('strips surrounding quotes before redacting', () => {
    const input = 'OPENAI_API_KEY="sk-proj-1234567890ABCDEF"';
    expect(redactEnvFile(input)).toBe('OPENAI_API_KEY=sk-••••••DEF');
  });

  test('leaves unknown keys alone (assume non-secret unless listed)', () => {
    const input = 'CUSTOM_RANDOM_VAR=abc123\n';
    expect(redactEnvFile(input)).toBe(input);
  });

  test('SECRET_ENV_KEYS covers all suffix-style secrets in MANAGED_ENV_KEYS', () => {
    // Cross-check against the suffix rule the server uses. Any key with
    // KEY/TOKEN/SECRET/PASSWORD suffix that we render in the browser must be
    // in SECRET_ENV_KEYS or it'd leak. This is a smoke check, not exhaustive.
    const required = [
      'GOLDPAN_AUTH_PASSWORD',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'TAVILY_API_KEY',
      'GOLDPAN_IM_TELEGRAM_BOT_TOKEN',
      'GOLDPAN_IM_FEISHU_APP_SECRET',
    ];
    for (const k of required) expect(SECRET_ENV_KEYS.has(k)).toBe(true);
  });

  test('redacts dynamic custom-provider keys via suffix fallback', () => {
    // User-chosen API-key env names (`TOGETHER_API_KEY`, `GROQ_API_KEY`)
    // declared at runtime through `*_API_KEY_ENV` are not pre-registered in
    // SECRET_ENV_KEYS. The suffix fallback in `isSecretEnvKey` mirrors the
    // server's SECRET_SUFFIX_RE so the env-fallback modal masks them too.
    const input = [
      'TOGETHER_API_KEY=tgp-1234567890ABCDEF',
      'GROQ_API_KEY=gsk-1234567890ABCDEF',
      'CUSTOM_TOKEN=tk-1234567890ABCDEF',
      'CUSTOM_SECRET=secret-1234567890',
      '',
    ].join('\n');
    const out = redactEnvFile(input);
    expect(out).toContain('TOGETHER_API_KEY=tgp••••••DEF');
    expect(out).toContain('GROQ_API_KEY=gsk••••••DEF');
    expect(out).toContain('CUSTOM_TOKEN=tk-••••••DEF');
    expect(out).toContain('CUSTOM_SECRET=sec••••••890');
    expect(out).not.toContain('1234567890ABCDEF');
    expect(out).not.toContain('1234567890');
  });
});

describe('isSecretEnvKey', () => {
  test('explicit SECRET_ENV_KEYS match', () => {
    expect(isSecretEnvKey('OPENAI_API_KEY')).toBe(true);
    expect(isSecretEnvKey('GOLDPAN_AUTH_PASSWORD')).toBe(true);
    expect(isSecretEnvKey('GOLDPAN_IM_FEISHU_ENCRYPT_KEY')).toBe(true);
  });

  test('suffix fallback for dynamic keys', () => {
    // User-chosen via UI, never pre-registered.
    expect(isSecretEnvKey('TOGETHER_API_KEY')).toBe(true);
    expect(isSecretEnvKey('GROQ_API_KEY')).toBe(true);
    expect(isSecretEnvKey('CUSTOM_TOKEN')).toBe(true);
    expect(isSecretEnvKey('CUSTOM_SECRET')).toBe(true);
    expect(isSecretEnvKey('CUSTOM_PASSWORD')).toBe(true);
  });

  test('non-secret keys', () => {
    expect(isSecretEnvKey('GOLDPAN_LANGUAGE')).toBe(false);
    expect(isSecretEnvKey('GOLDPAN_LLM_CLASSIFIER')).toBe(false);
    expect(isSecretEnvKey('GOLDPAN_LLM_PROVIDER_X_BASE_URL')).toBe(false);
    expect(isSecretEnvKey('GOLDPAN_LLM_PROVIDER_X_API_KEY_ENV')).toBe(false);
  });
});
