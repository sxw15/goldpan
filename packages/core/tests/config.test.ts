import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_ENV = {
  GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-sonnet-4-20250514',
  GOLDPAN_LLM_MATCHER: 'anthropic:claude-sonnet-4-20250514',
  GOLDPAN_LLM_COMPARATOR: 'anthropic:claude-sonnet-4-20250514',
  GOLDPAN_LLM_VERIFIER: 'openai:gpt-4o-mini',
};

describe('loadConfig', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all GOLDPAN_ vars to start clean
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GOLDPAN_')) delete process.env[key];
    }
    // Set minimum required env
    Object.assign(process.env, REQUIRED_ENV);
    // Reset module cache so each test gets fresh import
    vi.resetModules();
  });

  afterEach(() => {
    // Remove keys added during test
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    // Restore original values (mutation, not replacement)
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('loads valid config with defaults', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();

    expect(config.db.type).toBe('sqlite');
    expect(config.db.sqlitePath).toMatch(/[/\\]data[/\\]goldpan\.db$/);
    expect(config.logLevel).toBe('info');
    expect(config.workerInterval).toBe(5);
    expect(config.collectTimeout).toBe(30);
    expect(config.browserStrategy).toBe('auto');
    expect(config.llmTimeout).toBe(600);
    expect(config.outputFullThreshold).toBe(2);
    expect(config.outputIncrementThreshold).toBe(10);
    expect(config.maxTextInputLength).toBe(20000);
    expect(config.maxContentLength).toBe(30000);
    expect(config.minContentLength).toBe(50);
    expect(config.intentClassificationCharLimit).toBe(0);
    expect(config.serverSocketTimeoutMs).toBe(0);
    expect(config.trustProxy).toBe(false);
    expect(config.llm.classifier).toBe('openai:gpt-4o-mini');
    expect(config.llm.verifierEnabled).toBe(false);
  });

  it('rejects postgresql in V1', async () => {
    process.env.GOLDPAN_DB_TYPE = 'postgresql';
    const { loadConfig } = await import('../src/config/index.js');
    expect(() => loadConfig()).toThrow(/V1.*sqlite/i);
  });

  it('rejects missing auth password in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.GOLDPAN_AUTH_PASSWORD;
    const { loadConfig } = await import('../src/config/index.js');
    expect(() => loadConfig()).toThrow(/password.*production/i);
  });

  it('allows no password in development', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.GOLDPAN_AUTH_PASSWORD;
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.authPassword).toBeUndefined();
  });

  it('parses model ID format providerId:modelId', async () => {
    process.env.GOLDPAN_LLM_CLASSIFIER = 'deepseek:deepseek-chat';
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.llm.classifier).toBe('deepseek:deepseek-chat');
  });

  it('rejects invalid model ID format', async () => {
    process.env.GOLDPAN_LLM_CLASSIFIER = 'not-a-valid-model-id';
    const { loadConfig } = await import('../src/config/index.js');
    expect(() => loadConfig()).toThrow();
  });

  it('accepts Ollama model IDs with multiple colons', async () => {
    process.env.GOLDPAN_LLM_CLASSIFIER = 'ollama:qwen2.5:7b';
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.llm.classifier).toBe('ollama:qwen2.5:7b');
  });

  it('defaults llmLogPayloads to true in development', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.GOLDPAN_LLM_LOG_PAYLOADS;
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.llmLogPayloads).toBe(true);
  });

  it('defaults llmLogPayloads to false in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.GOLDPAN_AUTH_PASSWORD = 'securepassword123';
    delete process.env.GOLDPAN_LLM_LOG_PAYLOADS;
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.llmLogPayloads).toBe(false);
  });

  it('respects explicit llmLogPayloads override', async () => {
    process.env.NODE_ENV = 'development';
    process.env.GOLDPAN_LLM_LOG_PAYLOADS = 'false';
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.llmLogPayloads).toBe(false);
  });

  it('maps OPENAI_BASE_URL into providerBaseUrls', async () => {
    process.env.OPENAI_BASE_URL = 'https://proxy.example.com/v1';
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.providerBaseUrls.openai).toBe('https://proxy.example.com/v1');
  });

  it('rejects auth password shorter than 8 characters', async () => {
    process.env.GOLDPAN_AUTH_PASSWORD = 'short';
    const { loadConfig } = await import('../src/config/index.js');
    expect(() => loadConfig()).toThrow(/at least 8 characters/);
  });

  it('parses a custom GOLDPAN_MIN_CONTENT_LENGTH', async () => {
    process.env.GOLDPAN_MIN_CONTENT_LENGTH = '120';
    const { loadConfig } = await import('../src/config/index.js');
    expect(loadConfig().minContentLength).toBe(120);
  });

  it('rejects GOLDPAN_MIN_CONTENT_LENGTH greater than GOLDPAN_MAX_CONTENT_LENGTH', async () => {
    process.env.GOLDPAN_MAX_CONTENT_LENGTH = '100';
    process.env.GOLDPAN_MAX_TEXT_INPUT_LENGTH = '100';
    process.env.GOLDPAN_MIN_CONTENT_LENGTH = '500';
    const { loadConfig } = await import('../src/config/index.js');
    // Message is phrased in UI field-label terms (no raw GOLDPAN_* env key).
    expect(() => loadConfig()).toThrow(/min content length.*must not exceed/i);
  });

  it('parses GOLDPAN_LANGUAGE with default en', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.language).toBe('en');
  });

  it('parses GOLDPAN_LANGUAGE=zh', async () => {
    process.env.GOLDPAN_LANGUAGE = 'zh';
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.language).toBe('zh');
    delete process.env.GOLDPAN_LANGUAGE;
  });

  it('rejects invalid GOLDPAN_LANGUAGE', async () => {
    process.env.GOLDPAN_LANGUAGE = 'es';
    const { loadConfig } = await import('../src/config/index.js');
    expect(() => loadConfig()).toThrow();
    delete process.env.GOLDPAN_LANGUAGE;
  });

  describe('GOLDPAN_DIGEST_PUBLIC_BASE_URL', () => {
    it('accepts undefined (optional)', async () => {
      delete process.env.GOLDPAN_DIGEST_PUBLIC_BASE_URL;
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.digest.publicBaseUrl).toBeUndefined();
    });

    it('accepts https://digest.example.com', async () => {
      process.env.GOLDPAN_DIGEST_PUBLIC_BASE_URL = 'https://digest.example.com';
      const { loadConfig } = await import('../src/config/index.js');
      expect(loadConfig().digest.publicBaseUrl).toBe('https://digest.example.com');
    });

    it('accepts http://localhost:3000/path (path is OK)', async () => {
      process.env.GOLDPAN_DIGEST_PUBLIC_BASE_URL = 'http://localhost:3000/digest';
      const { loadConfig } = await import('../src/config/index.js');
      expect(loadConfig().digest.publicBaseUrl).toBe('http://localhost:3000/digest');
    });

    it('rejects URL with query string', async () => {
      process.env.GOLDPAN_DIGEST_PUBLIC_BASE_URL = 'https://x.example.com/?foo=1';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow(/http\(s\) URL without query string or fragment/);
    });

    it('rejects URL with fragment', async () => {
      process.env.GOLDPAN_DIGEST_PUBLIC_BASE_URL = 'https://x.example.com/#frag';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow(/http\(s\) URL without query string or fragment/);
    });

    it('rejects ftp:// protocol', async () => {
      process.env.GOLDPAN_DIGEST_PUBLIC_BASE_URL = 'ftp://x.example.com/';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow();
    });

    it('rejects javascript: pseudo-protocol', async () => {
      process.env.GOLDPAN_DIGEST_PUBLIC_BASE_URL = 'javascript:alert(1)';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow();
    });
  });

  it('parses GOLDPAN_BROWSER_STRATEGY', async () => {
    process.env.GOLDPAN_BROWSER_STRATEGY = 'bundled';
    const { loadConfig } = await import('../src/config/index.js');
    expect(loadConfig().browserStrategy).toBe('bundled');
  });

  it('parses GOLDPAN_SERVER_SOCKET_TIMEOUT_MS', async () => {
    process.env.GOLDPAN_SERVER_SOCKET_TIMEOUT_MS = '600000';
    const { loadConfig } = await import('../src/config/index.js');
    expect(loadConfig().serverSocketTimeoutMs).toBe(600_000);
  });

  it('rejects when fullThreshold > incrementThreshold', async () => {
    process.env.GOLDPAN_OUTPUT_FULL_THRESHOLD = '15';
    process.env.GOLDPAN_OUTPUT_INCREMENT_THRESHOLD = '5';
    const { loadConfig } = await import('../src/config/index.js');
    expect(() => loadConfig()).toThrow();
  });

  it('rejects when maxTextInputLength > maxContentLength', async () => {
    process.env.GOLDPAN_MAX_TEXT_INPUT_LENGTH = '50000';
    process.env.GOLDPAN_MAX_CONTENT_LENGTH = '30000';
    const { loadConfig } = await import('../src/config/index.js');
    expect(() => loadConfig()).toThrow();
  });

  it('defaults relation to disabled with no relator model', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.relation.enabled).toBe(false);
    expect(config.llm.relator).toBeUndefined();
  });

  it('enables relation extraction when GOLDPAN_RELATION_ENABLED=true', async () => {
    process.env.GOLDPAN_RELATION_ENABLED = 'true';
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.relation.enabled).toBe(true);
    expect(config.llm.relator).toBe('openai:gpt-4o-mini');
  });

  describe('IM config block', () => {
    // Channel-specific env (GOLDPAN_IM_TELEGRAM_*, GOLDPAN_IM_FEISHU_*) is now
    // owned by each plugin's `goldpanIMEnvSpec` — see those plugins' tests for
    // per-channel parse coverage. Core only retains runtime knobs that apply
    // across all channels, exercised below.
    it('defaults im to runtime knobs only when no IM env vars set', async () => {
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.im).toEqual({
        conversationWindowSize: 8,
        conversationTtlDays: 30,
        dedupeTtlHours: 72,
        dedupePurgeIntervalMinutes: 60,
      });
    });

    it('overrides default conversation window/ttl', async () => {
      process.env.GOLDPAN_IM_CONVERSATION_WINDOW_SIZE = '12';
      process.env.GOLDPAN_IM_CONVERSATION_TTL_DAYS = '60';
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.im.conversationWindowSize).toBe(12);
      expect(cfg.im.conversationTtlDays).toBe(60);
    });

    it('overrides default dedupe ttl / purge interval', async () => {
      process.env.GOLDPAN_IM_DEDUPE_TTL_HOURS = '24';
      process.env.GOLDPAN_IM_DEDUPE_PURGE_INTERVAL_MINUTES = '15';
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.im.dedupeTtlHours).toBe(24);
      expect(cfg.im.dedupePurgeIntervalMinutes).toBe(15);
    });
  });

  describe('llmProviderOptions (per-step thinking/reasoning)', () => {
    it('defaults to empty when no _OPTIONS env vars set', async () => {
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.llmProviderOptions).toEqual({});
    });

    it('parses a valid JSON object into the matching step+provider entry', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR = 'anthropic:claude-sonnet-4-20250514';
      process.env.GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS = '{"thinking":{"type":"adaptive"}}';
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.llmProviderOptions.extractor?.anthropic).toEqual({
        thinking: { type: 'adaptive' },
      });
    });

    it('rejects invalid JSON at startup', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS = '{not valid json';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow(/invalid json/i);
    });

    it('rejects JSON arrays', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS = '[1,2,3]';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow(/json object/i);
    });

    it('rejects JSON null', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS = 'null';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow(/json object/i);
    });

    it('rejects JSON scalars', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS = '"high"';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow(/json object/i);
    });

    it('treats empty string as unset', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS = '';
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.llmProviderOptions.extractor).toBeUndefined();
    });

    it('warns when options provider differs from step model provider', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR = 'openai:gpt-4o-mini';
      process.env.GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS = '{"thinking":{"type":"adaptive"}}';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/EXTRACTOR_ANTHROPIC_OPTIONS.*step "extractor".*"openai"/i),
      );
      // Mismatched entry is still kept so users can preset multi-provider configs
      expect(cfg.llmProviderOptions.extractor?.anthropic).toBeDefined();
      warnSpy.mockRestore();
    });

    it('does not warn when options provider matches step model provider', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR = 'anthropic:claude-sonnet-4-20250514';
      process.env.GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS =
        '{"thinking":{"type":"enabled","budgetTokens":12000}}';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadConfig } = await import('../src/config/index.js');
      loadConfig();
      const optionsWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('_OPTIONS'),
      );
      expect(optionsWarnings).toHaveLength(0);
      warnSpy.mockRestore();
    });

    it('populates options for multiple steps independently', async () => {
      process.env.GOLDPAN_LLM_CLASSIFIER = 'openai:gpt-4o-mini';
      process.env.GOLDPAN_LLM_QUERY = 'google:gemini-3-pro';
      process.env.GOLDPAN_LLM_CLASSIFIER_OPENAI_OPTIONS = '{"reasoningEffort":"low"}';
      process.env.GOLDPAN_LLM_QUERY_GOOGLE_OPTIONS = '{"thinkingConfig":{"thinkingLevel":"high"}}';
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.llmProviderOptions.classifier?.openai).toEqual({
        reasoningEffort: 'low',
      });
      expect(cfg.llmProviderOptions.query?.google).toEqual({
        thinkingConfig: { thinkingLevel: 'high' },
      });
    });

    it('skips options entries that are empty objects', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR_ANTHROPIC_OPTIONS = '{}';
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.llmProviderOptions.extractor).toBeUndefined();
    });
  });

  describe('llmStepTimeouts (per-step LLM timeouts)', () => {
    it('defaults to empty when no _TIMEOUT env vars set', async () => {
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.llmStepTimeouts).toEqual({});
      expect(cfg.llmTimeout).toBe(600);
    });

    it('parses one override and leaves other steps unset', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR_TIMEOUT = '120';
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.llmStepTimeouts.extractor).toBe(120);
      expect(cfg.llmStepTimeouts.classifier).toBeUndefined();
    });

    it('treats empty per-step timeout strings as unset', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR_TIMEOUT = '';
      process.env.GOLDPAN_LLM_MATCHER_TIMEOUT = '   ';
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.llmStepTimeouts.extractor).toBeUndefined();
      expect(cfg.llmStepTimeouts.matcher).toBeUndefined();
    });

    it('parses overrides for every supported step', async () => {
      process.env.GOLDPAN_LLM_CLASSIFIER_TIMEOUT = '5';
      process.env.GOLDPAN_LLM_EXTRACTOR_TIMEOUT = '120';
      process.env.GOLDPAN_LLM_MATCHER_TIMEOUT = '60';
      process.env.GOLDPAN_LLM_COMPARATOR_TIMEOUT = '60';
      process.env.GOLDPAN_LLM_VERIFIER_TIMEOUT = '20';
      process.env.GOLDPAN_LLM_RELATOR_TIMEOUT = '45';
      process.env.GOLDPAN_LLM_TRANSLATOR_TIMEOUT = '75';
      process.env.GOLDPAN_LLM_INTENT_TIMEOUT = '10';
      process.env.GOLDPAN_LLM_QUERY_TIMEOUT = '90';
      process.env.GOLDPAN_LLM_DIGEST_SUMMARY_TIMEOUT = '180';
      process.env.GOLDPAN_LLM_DIGEST_ACTION_TIMEOUT = '30';
      const { loadConfig } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(cfg.llmStepTimeouts).toEqual({
        classifier: 5,
        extractor: 120,
        matcher: 60,
        comparator: 60,
        verifier: 20,
        relator: 45,
        translator: 75,
        intent: 10,
        query: 90,
        digestSummary: 180,
        digestAction: 30,
      });
    });

    it('rejects values below 1', async () => {
      process.env.GOLDPAN_LLM_CLASSIFIER_TIMEOUT = '0';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow();
    });

    it('rejects values above 600', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR_TIMEOUT = '601';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow();
    });

    it('rejects non-integer values', async () => {
      process.env.GOLDPAN_LLM_MATCHER_TIMEOUT = '12.5';
      const { loadConfig } = await import('../src/config/index.js');
      expect(() => loadConfig()).toThrow();
    });
  });

  describe('resolveStepTimeout', () => {
    it('returns the per-step override when set', async () => {
      process.env.GOLDPAN_LLM_EXTRACTOR_TIMEOUT = '120';
      const { loadConfig, resolveStepTimeout } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(resolveStepTimeout(cfg, 'extractor')).toBe(120);
    });

    it('falls back to global llmTimeout when step has no override', async () => {
      process.env.GOLDPAN_LLM_TIMEOUT = '45';
      const { loadConfig, resolveStepTimeout } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(resolveStepTimeout(cfg, 'classifier')).toBe(45);
      expect(resolveStepTimeout(cfg, 'digestSummary')).toBe(45);
    });

    it('overrides win even when global differs', async () => {
      process.env.GOLDPAN_LLM_TIMEOUT = '45';
      process.env.GOLDPAN_LLM_QUERY_TIMEOUT = '90';
      const { loadConfig, resolveStepTimeout } = await import('../src/config/index.js');
      const cfg = loadConfig();
      expect(resolveStepTimeout(cfg, 'query')).toBe(90);
      expect(resolveStepTimeout(cfg, 'classifier')).toBe(45);
    });
  });
});
