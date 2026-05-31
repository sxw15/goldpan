import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { isWizardHandle } from '../../src/bootstrap';
import { lenientLoadConfig } from '../../src/config';
import { detectWizardMode } from '../../src/onboarding/wizard-mode';
import { bootstrapForTest } from '../helpers/bootstrap-with-env';

describe('lenientLoadConfig', () => {
  test('returns ok=true on minimal valid env', () => {
    const result = lenientLoadConfig({ DATABASE_PATH: ':memory:' });
    expect(result.ok).toBe(true);
  });

  test('returns ok=false with zod errors on bad model format', () => {
    const result = lenientLoadConfig({ GOLDPAN_LLM_CLASSIFIER: 'not-a-valid-format' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes('GOLDPAN_LLM_CLASSIFIER'))).toBe(true);
    }
  });

  test('skips production-requires-auth-password cross-field check', () => {
    // strict loadConfig() throws here; lenient must succeed
    const result = lenientLoadConfig({ NODE_ENV: 'production' });
    expect(result.ok).toBe(true);
  });

  test('skips threshold-ordering cross-field check', () => {
    const result = lenientLoadConfig({
      GOLDPAN_OUTPUT_FULL_THRESHOLD: '99',
      GOLDPAN_OUTPUT_INCREMENT_THRESHOLD: '1', // would fail strict; lenient OK
    });
    expect(result.ok).toBe(true);
  });

  test('still rejects malformed JSON in *_OPTIONS', () => {
    const result = lenientLoadConfig({
      GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS: 'not-json',
    });
    expect(result.ok).toBe(false);
  });
});

describe('detectWizardMode', () => {
  function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
    const backup = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      process.env = backup;
    }
  }

  test('GOLDPAN_FORCE_WIZARD=true → forced', () => {
    withEnv({ GOLDPAN_FORCE_WIZARD: 'true', OPENAI_API_KEY: 'sk-x' }, () => {
      const r = detectWizardMode();
      expect(r?.kind).toBe('forced');
    });
  });

  test('lenient config errors → config_invalid', () => {
    withEnv({ GOLDPAN_FORCE_WIZARD: undefined, GOLDPAN_LLM_CLASSIFIER: 'broken' }, () => {
      const r = detectWizardMode();
      expect(r?.kind).toBe('config_invalid');
    });
  });

  test('production without auth password → missing_auth_password', () => {
    withEnv(
      {
        GOLDPAN_FORCE_WIZARD: undefined,
        NODE_ENV: 'production',
        GOLDPAN_AUTH_PASSWORD: undefined,
        OPENAI_API_KEY: 'sk-x',
      },
      () => {
        const r = detectWizardMode();
        expect(r?.kind).toBe('missing_auth_password');
      },
    );
  });

  test('no provider keys but openai/anthropic referenced → no_provider_key', () => {
    withEnv(
      {
        GOLDPAN_FORCE_WIZARD: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        DEEPSEEK_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
        GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-sonnet-4-20250514',
      },
      () => {
        const r = detectWizardMode();
        expect(r?.kind).toBe('no_provider_key');
      },
    );
  });

  test('missing key for any referenced provider → no_provider_key', () => {
    withEnv(
      {
        GOLDPAN_FORCE_WIZARD: undefined,
        OPENAI_API_KEY: 'sk-openai',
        ANTHROPIC_API_KEY: undefined,
        GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
        GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-sonnet-4-20250514',
      },
      () => {
        const r = detectWizardMode();
        expect(r?.kind).toBe('no_provider_key');
        if (r?.kind === 'no_provider_key') {
          expect(r.referenced).toContain('anthropic');
          expect(r.referenced).not.toContain('openai');
        }
      },
    );
  });

  test('embedding default provider counts when embedding is enabled', () => {
    withEnv(
      {
        GOLDPAN_FORCE_WIZARD: undefined,
        OPENAI_API_KEY: undefined,
        GOLDPAN_LLM_CLASSIFIER: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_EXTRACTOR: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_MATCHER: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_COMPARATOR: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_INTENT: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_QUERY: 'ollama:qwen2.5:7b',
        GOLDPAN_EMBEDDING_ENABLED: 'true',
      },
      () => {
        const r = detectWizardMode();
        expect(r?.kind).toBe('no_provider_key');
        if (r?.kind === 'no_provider_key') expect(r.referenced).toEqual(['openai']);
      },
    );
  });

  test('all referenced providers are keyless (ollama) → no wizard', () => {
    withEnv(
      {
        GOLDPAN_FORCE_WIZARD: undefined,
        OPENAI_API_KEY: undefined,
        GOLDPAN_LLM_CLASSIFIER: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_EXTRACTOR: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_MATCHER: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_COMPARATOR: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_INTENT: 'ollama:qwen2.5:7b',
        GOLDPAN_LLM_QUERY: 'ollama:qwen2.5:7b',
      },
      () => {
        const r = detectWizardMode();
        expect(r).toBeNull();
      },
    );
  });

  test('happy path with all keys → null', () => {
    withEnv(
      { GOLDPAN_FORCE_WIZARD: undefined, OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'sk' },
      () => {
        const r = detectWizardMode();
        expect(r).toBeNull();
      },
    );
  });

  test('fully-configured custom provider → null (regression: wizard commit/restart loop)', () => {
    withEnv(
      {
        GOLDPAN_FORCE_WIZARD: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        GOLDPAN_LLM_CLASSIFIER: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_EXTRACTOR: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_MATCHER: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_COMPARATOR: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_INTENT: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_QUERY: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_PROVIDER_SENSENOVA_BASE_URL: 'https://token.sensenova.cn/v1',
        GOLDPAN_LLM_PROVIDER_SENSENOVA_API_KEY_ENV: 'SENSENOVA_API_KEY',
        GOLDPAN_LLM_PROVIDER_SENSENOVA_MODELS: 'deepseek-v4-flash',
        SENSENOVA_API_KEY: 'sk-test',
      },
      () => {
        const r = detectWizardMode();
        expect(r).toBeNull();
      },
    );
  });

  test('custom provider declared but its api key env unset → no_provider_key', () => {
    withEnv(
      {
        GOLDPAN_FORCE_WIZARD: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        GOLDPAN_LLM_CLASSIFIER: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_EXTRACTOR: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_MATCHER: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_COMPARATOR: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_INTENT: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_QUERY: 'sensenova:deepseek-v4-flash',
        GOLDPAN_LLM_PROVIDER_SENSENOVA_BASE_URL: 'https://token.sensenova.cn/v1',
        GOLDPAN_LLM_PROVIDER_SENSENOVA_API_KEY_ENV: 'SENSENOVA_API_KEY',
        SENSENOVA_API_KEY: undefined,
      },
      () => {
        const r = detectWizardMode();
        expect(r?.kind).toBe('no_provider_key');
        if (r?.kind === 'no_provider_key') expect(r.referenced).toContain('sensenova');
      },
    );
  });
});

describe('bootstrap mode=wizard', () => {
  // Set GOLDPAN_DB_SQLITE_PATH to a temp path so the wizard short-circuit
  // doesn't write into the project's ./data dir during tests.
  let prevDbPath: string | undefined;
  let tmpDir: string;
  let tmpDbPath: string;

  beforeEach(() => {
    prevDbPath = process.env.GOLDPAN_DB_SQLITE_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-bootstrap-'));
    tmpDbPath = path.join(tmpDir, 'wizard.db');
    process.env.GOLDPAN_DB_SQLITE_PATH = tmpDbPath;
  });

  afterEach(() => {
    if (prevDbPath === undefined) delete process.env.GOLDPAN_DB_SQLITE_PATH;
    else process.env.GOLDPAN_DB_SQLITE_PATH = prevDbPath;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  test('mode=wizard always returns WizardBootstrapHandle (forced)', async () => {
    const handle = await bootstrapForTest({ mode: 'wizard' });
    expect(isWizardHandle(handle)).toBe(true);
    if (isWizardHandle(handle)) {
      expect(handle.mode).toBe('wizard');
      expect(handle.reason.kind).toBe('forced');
      expect(handle.metadataRepo).toBeDefined();
      expect(handle.db).toBeDefined();
    }
    await handle.shutdown();
  });

  test('mode=auto returns wizard handle when config has format error', async () => {
    const prev = process.env.GOLDPAN_LLM_CLASSIFIER;
    process.env.GOLDPAN_LLM_CLASSIFIER = 'broken';
    try {
      const handle = await bootstrapForTest({ mode: 'auto' });
      expect(isWizardHandle(handle)).toBe(true);
      if (isWizardHandle(handle)) {
        expect(handle.reason.kind).toBe('config_invalid');
      }
      await handle.shutdown();
    } finally {
      if (prev === undefined) delete process.env.GOLDPAN_LLM_CLASSIFIER;
      else process.env.GOLDPAN_LLM_CLASSIFIER = prev;
    }
  });
});
