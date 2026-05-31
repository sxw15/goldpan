import { describe, expect, test } from 'vitest';
import { validateStagedConfig } from '../../src/onboarding/validate';

/**
 * Run `fn` with a clean snapshot of process.env: drop any keys that could
 * mask the assertion (auth password from dev shell, provider keys, NODE_ENV
 * inherited from vitest), then restore on `finally`.
 *
 * `validateStagedConfig` does `{ ...process.env, ...staged }` internally, so
 * stale shell values would otherwise leak into the merged env and either
 * accidentally satisfy a check we expect to fail or fail one we expect to
 * pass.
 */
function withCleanEnv<T>(fn: () => T): T {
  const keysToClean = [
    'NODE_ENV',
    'GOLDPAN_AUTH_PASSWORD',
    'GOLDPAN_FORCE_WIZARD',
    'GOLDPAN_LLM_CLASSIFIER',
    'GOLDPAN_LLM_EXTRACTOR',
    'GOLDPAN_LLM_MATCHER',
    'GOLDPAN_LLM_COMPARATOR',
    'GOLDPAN_LLM_INTENT',
    'GOLDPAN_LLM_QUERY',
    'GOLDPAN_OUTPUT_FULL_THRESHOLD',
    'GOLDPAN_OUTPUT_INCREMENT_THRESHOLD',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL',
    'GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV',
    'TOGETHER_API_KEY',
    'GOLDPAN_EMBEDDING_ENABLED',
    'GOLDPAN_EMBEDDING_MODEL',
  ];
  const backup: Record<string, string | undefined> = {};
  for (const k of keysToClean) {
    backup[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('validateStagedConfig', () => {
  test('passes for fully valid staged keys', () => {
    withCleanEnv(() => {
      const result = validateStagedConfig({
        GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
        GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-sonnet-4-20250514',
        OPENAI_API_KEY: 'sk-xxx',
        ANTHROPIC_API_KEY: 'sk-yyy',
      });
      expect(result.ok).toBe(true);
    });
  });

  test('rejects bad model id format', () => {
    withCleanEnv(() => {
      const result = validateStagedConfig({ GOLDPAN_LLM_CLASSIFIER: 'broken' });
      expect(result.ok).toBe(false);
    });
  });

  test('rejects threshold ordering violation (cross-field)', () => {
    withCleanEnv(() => {
      const result = validateStagedConfig({
        GOLDPAN_OUTPUT_FULL_THRESHOLD: '99',
        GOLDPAN_OUTPUT_INCREMENT_THRESHOLD: '1',
      });
      expect(result.ok).toBe(false);
      // Message is now phrased in plain words ("Output full threshold …"), not
      // the raw GOLDPAN_*_THRESHOLD env keys — match case-insensitively.
      if (!result.ok) expect(result.errors[0].message).toMatch(/threshold/i);
    });
  });

  test('content-length min>max carries a localizable code', () => {
    // The two content-length cross-field rules gate user-editable hot fields, so
    // they attach a stable `code` the settings UI localizes (localizeCommitError).
    withCleanEnv(() => {
      const result = validateStagedConfig({
        GOLDPAN_MAX_CONTENT_LENGTH: '100',
        GOLDPAN_MAX_TEXT_INPUT_LENGTH: '100',
        GOLDPAN_MIN_CONTENT_LENGTH: '500',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0].code).toBe('content_length_min_exceeds_max');
    });
  });

  test('rejects production without auth password', () => {
    withCleanEnv(() => {
      const result = validateStagedConfig({ NODE_ENV: 'production' });
      expect(result.ok).toBe(false);
    });
  });

  test('rejects missing key for any referenced provider', () => {
    withCleanEnv(() => {
      const result = validateStagedConfig({
        GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
        GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-sonnet-4-20250514',
        OPENAI_API_KEY: 'sk-openai',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0].message).toMatch(/ANTHROPIC_API_KEY/);
    });
  });

  test('accepts OpenRouter when OPENROUTER_API_KEY is set', () => {
    withCleanEnv(() => {
      const result = validateStagedConfig({
        GOLDPAN_LLM_CLASSIFIER: 'openrouter:openai/gpt-4o-mini',
        GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-sonnet-4-20250514',
        OPENAI_API_KEY: 'sk-openai',
        ANTHROPIC_API_KEY: 'sk-anthropic',
        OPENROUTER_API_KEY: 'sk-or-v1-test',
      });
      expect(result.ok).toBe(true);
    });
  });

  test('accepts configured custom providers by their declared apiKeyEnv', () => {
    withCleanEnv(() => {
      const result = validateStagedConfig({
        GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL: 'https://api.together.xyz/v1',
        GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV: 'TOGETHER_API_KEY',
        TOGETHER_API_KEY: 'sk-together',
        GOLDPAN_LLM_CLASSIFIER: 'together:meta-llama/Llama-3.3-70B-Instruct-Turbo',
        GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-sonnet-4-20250514',
        OPENAI_API_KEY: 'sk-openai',
        ANTHROPIC_API_KEY: 'sk-anthropic',
      });
      expect(result.ok).toBe(true);
    });
  });

  test('accepts plugin providers supplied by the settings route', () => {
    withCleanEnv(() => {
      const result = validateStagedConfig(
        {
          GOLDPAN_LLM_CLASSIFIER: 'cohere:command-r-plus',
          GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-sonnet-4-20250514',
          OPENAI_API_KEY: 'sk-openai',
          ANTHROPIC_API_KEY: 'sk-anthropic',
        },
        { knownLlmProviderIds: ['cohere'] },
      );
      expect(result.ok).toBe(true);
    });
  });

  test('rejects incomplete verifier model even while verifier is disabled', () => {
    withCleanEnv(() => {
      const result = validateStagedConfig(
        {
          GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
          GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-sonnet-4-20250514',
          GOLDPAN_LLM_VERIFIER_ENABLED: 'false',
          GOLDPAN_LLM_VERIFIER: 'openai:',
          OPENAI_API_KEY: 'sk-openai',
          ANTHROPIC_API_KEY: 'sk-anthropic',
        },
        { touchedKeys: ['GOLDPAN_LLM_VERIFIER'] },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0].path).toBe('GOLDPAN_LLM_VERIFIER');
    });
  });

  test('rejects missing embedding provider key when embedding uses default model', () => {
    withCleanEnv(() => {
      const result = validateStagedConfig({
        GOLDPAN_LLM_CLASSIFIER: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_EXTRACTOR: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_MATCHER: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_COMPARATOR: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_INTENT: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_QUERY: 'ollama:qwen2.5:7b',
        GOLDPAN_EMBEDDING_ENABLED: 'true',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0].message).toMatch(/OPENAI_API_KEY/);
    });
  });
});
