import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  extractDynamicAllowedEnvNames,
  isManagedEnvKey,
  MANAGED_ENV_KEYS,
  readEnvFile,
} from '../../src/onboarding/env-file';

function tmpEnv(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content);
  return file;
}

describe('MANAGED_ENV_KEYS', () => {
  test('contains all keys listed in spec §4.1', () => {
    expect(MANAGED_ENV_KEYS).toContain('GOLDPAN_LANGUAGE');
    expect(MANAGED_ENV_KEYS).toContain('OPENAI_API_KEY');
    expect(MANAGED_ENV_KEYS).toContain('GOLDPAN_IM_TELEGRAM_BOT_TOKEN');
    expect(MANAGED_ENV_KEYS).toContain('GOLDPAN_EMBEDDING_ENABLED');
    expect(MANAGED_ENV_KEYS).toContain('GOLDPAN_TRACKING_SCHEDULER_ENABLED');
  });
});

describe('readEnvFile', () => {
  test('preserves comments and blank lines verbatim', () => {
    const file = tmpEnv(
      `# Goldpan config\n# Provider keys\n\nOPENAI_API_KEY=sk-xxx\n# trailing comment\n`,
    );
    const result = readEnvFile(file);
    expect(result.lines).toEqual([
      '# Goldpan config',
      '# Provider keys',
      '',
      'OPENAI_API_KEY=sk-xxx',
      '# trailing comment',
    ]);
  });

  test('returns keyToLineIdx for managed keys only', () => {
    const file = tmpEnv(`OPENAI_API_KEY=sk-xxx\nGOLDPAN_INTENT_CLASSIFICATION_CHAR_LIMIT=8000\n`);
    const result = readEnvFile(file);
    expect(result.keyToLineIdx.get('OPENAI_API_KEY')).toBe(0);
    expect(result.keyToLineIdx.get('GOLDPAN_INTENT_CLASSIFICATION_CHAR_LIMIT')).toBeUndefined();
  });

  test('handles missing file as empty', () => {
    const result = readEnvFile('/nonexistent/.env');
    expect(result.lines).toEqual([]);
    expect(result.keyToLineIdx.size).toBe(0);
  });

  test('throws read errors other than missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-env-dir-'));
    expect(() => readEnvFile(dir)).toThrow();
  });

  test('handles quoted values', () => {
    const file = tmpEnv(`GOLDPAN_AUTH_PASSWORD="hello world"\n`);
    const result = readEnvFile(file);
    expect(result.keyToLineIdx.get('GOLDPAN_AUTH_PASSWORD')).toBe(0);
  });

  test('parses managed-key values, undoing the dotenv-style quoting conventions', () => {
    // Construct the `.env` raw bytes by hand — values that contain spaces /
    // quotes / backslashes are wrapped in `"..."` with `\\` and `\"` escapes,
    // matching what dotenv (and docker-compose) emit. `parseEnvValue` should
    // round-trip these back to the original logical values.
    const file = tmpEnv(
      [
        'GOLDPAN_LANGUAGE=zh',
        'GOLDPAN_AUTH_PASSWORD="with space"',
        'OPENAI_API_KEY="sk-with\\"quote"',
        'GOLDPAN_IM_TELEGRAM_BOT_TOKEN="has\\\\backslash"',
      ].join('\n') + '\n',
    );
    const result = readEnvFile(file);
    expect(result.values.get('GOLDPAN_LANGUAGE')).toBe('zh');
    expect(result.values.get('GOLDPAN_AUTH_PASSWORD')).toBe('with space');
    expect(result.values.get('OPENAI_API_KEY')).toBe('sk-with"quote');
    expect(result.values.get('GOLDPAN_IM_TELEGRAM_BOT_TOKEN')).toBe('has\\backslash');
  });

  test('values map skips unmanaged keys', () => {
    const file = tmpEnv(`OPENAI_API_KEY=sk\nGOLDPAN_INTENT_CLASSIFICATION_CHAR_LIMIT=8000\n`);
    const result = readEnvFile(file);
    expect(result.values.get('OPENAI_API_KEY')).toBe('sk');
    expect(result.values.has('GOLDPAN_INTENT_CLASSIFICATION_CHAR_LIMIT')).toBe(false);
  });
});

describe('isManagedEnvKey', () => {
  test('accepts literal MANAGED_ENV_KEYS entries', () => {
    expect(isManagedEnvKey('OPENAI_API_KEY')).toBe(true);
    expect(isManagedEnvKey('GOLDPAN_LANGUAGE')).toBe(true);
    expect(isManagedEnvKey('GOLDPAN_AUTH_PASSWORD')).toBe(true);
  });

  test('accepts dynamic GOLDPAN_LLM_PROVIDER_*_BASE_URL', () => {
    expect(isManagedEnvKey('GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL')).toBe(true);
    expect(isManagedEnvKey('GOLDPAN_LLM_PROVIDER_X_BASE_URL')).toBe(true);
    expect(isManagedEnvKey('GOLDPAN_LLM_PROVIDER_GROQ_2_BASE_URL')).toBe(true);
  });

  test('accepts dynamic GOLDPAN_LLM_PROVIDER_*_API_KEY_ENV', () => {
    expect(isManagedEnvKey('GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV')).toBe(true);
    expect(isManagedEnvKey('GOLDPAN_LLM_PROVIDER_GROQ_API_KEY_ENV')).toBe(true);
  });

  test('rejects malformed dynamic keys', () => {
    // Missing provider id (consecutive underscores): regex requires at least
    // one [A-Z] before the second underscore, so a bare `_BASE_URL` shape
    // without an id segment must fail closed. Otherwise a typo could let
    // arbitrary writers slip through under the dynamic-pattern allowance.
    expect(isManagedEnvKey('GOLDPAN_LLM_PROVIDER_BASE_URL')).toBe(false);
    // Lowercase id violates env-var convention (and gives the regex something
    // to anchor against to keep the shape predictable).
    expect(isManagedEnvKey('GOLDPAN_LLM_PROVIDER_lower_BASE_URL')).toBe(false);
    // Suffix outside the allowed set (BASE_URL / API_KEY_ENV) — anything else
    // would let plugins tunnel arbitrary keys through the dynamic allowance.
    expect(isManagedEnvKey('GOLDPAN_LLM_PROVIDER_X_OTHER')).toBe(false);
    expect(isManagedEnvKey('GOLDPAN_LLM_PROVIDER_X_API_KEY')).toBe(false);
  });

  test('accepts per-step provider OPTIONS keys (thinking/reasoning)', () => {
    expect(isManagedEnvKey('GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS')).toBe(true);
    expect(isManagedEnvKey('GOLDPAN_LLM_QUERY_OPENAI_OPTIONS')).toBe(true);
    expect(isManagedEnvKey('GOLDPAN_LLM_CLASSIFIER_GOOGLE_OPTIONS')).toBe(true);
    expect(isManagedEnvKey('GOLDPAN_LLM_DIGEST_SUMMARY_DEEPSEEK_OPTIONS')).toBe(true);
    expect(isManagedEnvKey('GOLDPAN_LLM_TRANSLATOR_ANTHROPIC_OPTIONS')).toBe(true);
  });

  test('rejects OPTIONS keys with unknown step or provider', () => {
    // Step alternation is strict — a typo or new step that hasn't been added
    // to the pattern falls through. zod schema (`llmStepProviderOptionsShape`)
    // would also reject these, but the whitelist is the first gate so commit
    // doesn't even reach validation with a malformed key.
    expect(isManagedEnvKey('GOLDPAN_LLM_FAKE_STEP_OPENAI_OPTIONS')).toBe(false);
    expect(isManagedEnvKey('GOLDPAN_LLM_EXTRACTOR_OLLAMA_OPTIONS')).toBe(false);
    expect(isManagedEnvKey('GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTION')).toBe(false);
    expect(isManagedEnvKey('GOLDPAN_LLM_EXTRACTOR_OPTIONS')).toBe(false);
  });

  test('accepts plugin-declared keys', () => {
    expect(isManagedEnvKey('PLUGIN_X_API_KEY', ['PLUGIN_X_API_KEY'])).toBe(true);
    expect(isManagedEnvKey('PLUGIN_X_API_KEY', [])).toBe(false);
  });

  test('accepts dynamic per-patch allowlist', () => {
    expect(isManagedEnvKey('TOGETHER_API_KEY', [], ['TOGETHER_API_KEY'])).toBe(true);
    expect(isManagedEnvKey('TOGETHER_API_KEY', [], [])).toBe(false);
  });

  test('rejects unknown keys with no allowlist match', () => {
    expect(isManagedEnvKey('RANDOM_VAR')).toBe(false);
    expect(isManagedEnvKey('SOME_OTHER_KEY')).toBe(false);
  });
});

describe('extractDynamicAllowedEnvNames', () => {
  test('extracts env names from *_API_KEY_ENV declarations', () => {
    const patch = new Map([
      ['GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL', 'https://api.together.xyz/v1'],
      ['GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV', 'TOGETHER_API_KEY'],
      ['TOGETHER_API_KEY', 'tgp_secret'],
    ]);
    expect(extractDynamicAllowedEnvNames(patch)).toEqual(['TOGETHER_API_KEY']);
  });

  test('rejects malformed env name values (defensive)', () => {
    // The decl value is user-controlled; if a UI bug or hand-crafted client
    // sends a lowercase or slash-bearing name we must drop it on the floor
    // rather than treat it as managed — that would let an attacker write any
    // arbitrary env var by claiming it's a custom-provider api-key.
    const patch = new Map([
      ['GOLDPAN_LLM_PROVIDER_X_API_KEY_ENV', 'lowercase_bad'],
      ['GOLDPAN_LLM_PROVIDER_Y_API_KEY_ENV', 'PATH'], // valid shape, but allowed
    ]);
    // Only PATH passes the shape check; lowercase_bad is dropped.
    expect(extractDynamicAllowedEnvNames(patch)).toEqual(['PATH']);
  });

  test('returns empty array when no *_API_KEY_ENV declarations', () => {
    const patch = new Map([['OPENAI_API_KEY', 'sk-test']]);
    expect(extractDynamicAllowedEnvNames(patch)).toEqual([]);
  });

  test('handles multiple custom providers in one patch', () => {
    const patch = new Map([
      ['GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV', 'TOGETHER_API_KEY'],
      ['GOLDPAN_LLM_PROVIDER_GROQ_API_KEY_ENV', 'GROQ_API_KEY'],
      ['TOGETHER_API_KEY', 'tgp_secret'],
      ['GROQ_API_KEY', 'gsk_secret'],
    ]);
    expect(extractDynamicAllowedEnvNames(patch).sort()).toEqual([
      'GROQ_API_KEY',
      'TOGETHER_API_KEY',
    ]);
  });

  test('ignores non-API_KEY_ENV declarations even with valid env-name shape', () => {
    // Defense in depth: even if a BASE_URL value happens to look like an env
    // name, we don't treat it as managed — the dynamic allowlist is sourced
    // strictly from `*_API_KEY_ENV` keys.
    const patch = new Map([['GOLDPAN_LLM_PROVIDER_X_BASE_URL', 'SOMETHING_LOOKING_LIKE_ENV']]);
    expect(extractDynamicAllowedEnvNames(patch)).toEqual([]);
  });
});

describe('readEnvFile dynamic patterns', () => {
  test('tracks GOLDPAN_LLM_PROVIDER_*_BASE_URL keys saved on a previous patch', () => {
    // Round-trip guarantee: dynamic provider keys saved on a prior commit must
    // come back as `values` entries on next read so the settings UI / next
    // commit sees them. Without this, a custom-provider config would silently
    // disappear from buildEnvStateForKeys after restart.
    const file = tmpEnv(
      [
        'GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL=https://api.together.xyz/v1',
        'GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV=TOGETHER_API_KEY',
      ].join('\n') + '\n',
    );
    const result = readEnvFile(file);
    expect(result.values.get('GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL')).toBe(
      'https://api.together.xyz/v1',
    );
    expect(result.values.get('GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV')).toBe('TOGETHER_API_KEY');
  });

  test('does NOT track user-chosen API key var names (not pattern-matchable)', () => {
    // The user's chosen secret env var (e.g. `TOGETHER_API_KEY`) does not
    // fit any pattern — `readEnvFile` can't know which random env-name shapes
    // to claim without context. Settings UI must re-derive these from the
    // declared `_API_KEY_ENV` value when displaying.
    const file = tmpEnv('TOGETHER_API_KEY=tgp_secret\n');
    const result = readEnvFile(file);
    expect(result.values.get('TOGETHER_API_KEY')).toBeUndefined();
  });
});
