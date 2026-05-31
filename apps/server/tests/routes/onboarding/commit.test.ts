// apps/server/tests/routes/onboarding/commit.test.ts
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import type { ImSettingsManifest } from '@goldpan/im-runtime';
import { describe, expect, test } from 'vitest';
import { validateStagedBaseUrls } from '../../../src/lib/base-url-security.js';
import { createCommitHandler, stateToEnvKeys } from '../../../src/routes/onboarding/commit.js';
import {
  patchWizardState,
  resetWizardState,
  type WizardState,
} from '../../../src/routes/onboarding/state.js';

function makeManifest(channelId: string): ImSettingsManifest {
  return {
    channelId,
    branding: { name: { en: channelId, zh: channelId } },
    enable: {
      envKey: `GOLDPAN_IM_${channelId.toUpperCase()}_ENABLED`,
      label: { en: 'on', zh: '开' },
      default: false,
    },
    fields: [
      {
        name: 'token',
        kind: 'secret',
        label: { en: 'T', zh: 'T' },
        envKey: `GOLDPAN_IM_${channelId.toUpperCase()}_TOKEN`,
      },
      {
        name: 'urlTemplate',
        kind: 'text',
        label: { en: 'U', zh: 'U' },
        envKey: `GOLDPAN_IM_${channelId.toUpperCase()}_URL`,
      },
    ],
    actions: [],
    setupGuide: { allDoneTitle: { en: 'D', zh: '完' }, steps: [] },
  };
}

describe('stateToEnvKeys', () => {
  test('serializes language + web + auth', () => {
    const state: WizardState = {
      providers: {},
      steps: {},
      language: 'zh',
      webEnabled: false,
      authPassword: 'secret123',
    };
    const m = stateToEnvKeys(state);
    expect(m.get('GOLDPAN_LANGUAGE')).toBe('zh');
    expect(m.get('GOLDPAN_WEB_ENABLED')).toBe('false');
    expect(m.get('GOLDPAN_AUTH_PASSWORD')).toBe('secret123');
  });

  test('serializes providers + step models', () => {
    const state: WizardState = {
      providers: { openai: { apiKey: 'sk-xxx' }, anthropic: { apiKey: 'sk-ant' } },
      steps: {
        classifier: { model: 'openai:gpt-4o-mini' },
        extractor: { model: 'anthropic:claude-sonnet-4-20250514' },
      },
    };
    const m = stateToEnvKeys(state);
    expect(m.get('OPENAI_API_KEY')).toBe('sk-xxx');
    expect(m.get('ANTHROPIC_API_KEY')).toBe('sk-ant');
    expect(m.get('GOLDPAN_LLM_CLASSIFIER')).toBe('openai:gpt-4o-mini');
  });

  test('serializes per-provider models as csv into GOLDPAN_LLM_PROVIDER_<ID>_MODELS', () => {
    const state: WizardState = {
      providers: {
        openai: { apiKey: 'sk', models: ['gpt-4o-mini', 'gpt-4o'] },
        ollama: { baseUrl: 'http://x', models: [] },
      },
      steps: {},
    };
    const m = stateToEnvKeys(state);
    expect(m.get('GOLDPAN_LLM_PROVIDER_OPENAI_MODELS')).toBe('gpt-4o-mini,gpt-4o');
    // Empty arrays are skipped — no key emitted, so the key in .env is left
    // alone and existing baseline / override value isn't overwritten by '' .
    expect(m.has('GOLDPAN_LLM_PROVIDER_OLLAMA_MODELS')).toBe(false);
  });

  test('serializes Ollama provider presence into GOLDPAN_OLLAMA_ENABLED=true', () => {
    const state: WizardState = {
      providers: {
        ollama: { baseUrl: 'http://localhost:11434/v1', models: ['llama3.2:8b'] },
      },
      steps: {},
    };
    const m = stateToEnvKeys(state);
    expect(m.get('OLLAMA_BASE_URL')).toBe('http://localhost:11434/v1');
    expect(m.get('GOLDPAN_OLLAMA_ENABLED')).toBe('true');
  });

  test('serializes custom OpenAI-compat provider as 4 env keys (BASE_URL + API_KEY_ENV + MODELS + secret)', () => {
    const state: WizardState = {
      providers: {
        together: {
          apiKey: 'tk-xyz',
          baseUrl: 'https://api.together.xyz/v1',
          apiKeyEnv: 'TOGETHER_API_KEY',
          models: ['mistralai/Mixtral-8x7B-Instruct-v0.1'],
        },
      },
      steps: {},
    };
    const m = stateToEnvKeys(state);
    expect(m.get('GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL')).toBe('https://api.together.xyz/v1');
    expect(m.get('GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV')).toBe('TOGETHER_API_KEY');
    expect(m.get('GOLDPAN_LLM_PROVIDER_TOGETHER_MODELS')).toBe(
      'mistralai/Mixtral-8x7B-Instruct-v0.1',
    );
    expect(m.get('TOGETHER_API_KEY')).toBe('tk-xyz');
    // Builtin secret env names must NOT be emitted for a custom provider.
    expect(m.has('OPENAI_API_KEY')).toBe(false);
  });

  test('skips empty optional fields (no GOLDPAN_AUTH_PASSWORD= line)', () => {
    const state: WizardState = { providers: {}, steps: {} };
    const m = stateToEnvKeys(state);
    expect(m.has('GOLDPAN_AUTH_PASSWORD')).toBe(false);
  });

  test('serializes verifier toggle separately', () => {
    const state: WizardState = {
      providers: { openai: { apiKey: 'sk' } },
      steps: { verifier: { enabled: true, model: 'openai:gpt-4o-mini' } },
    };
    const m = stateToEnvKeys(state);
    expect(m.get('GOLDPAN_LLM_VERIFIER_ENABLED')).toBe('true');
    expect(m.get('GOLDPAN_LLM_VERIFIER')).toBe('openai:gpt-4o-mini');
  });

  test('IM: walks manifests — emits enable + every populated field for an enabled channel', () => {
    const state: WizardState = {
      providers: {},
      steps: {},
      im: {
        telegram: {
          enabled: true,
          fields: { token: 'tok-abc', urlTemplate: 'https://kb/{id}' },
        },
      },
    };
    const m = stateToEnvKeys(state, [makeManifest('telegram')]);
    expect(m.get('GOLDPAN_IM_TELEGRAM_ENABLED')).toBe('true');
    expect(m.get('GOLDPAN_IM_TELEGRAM_TOKEN')).toBe('tok-abc');
    expect(m.get('GOLDPAN_IM_TELEGRAM_URL')).toBe('https://kb/{id}');
  });

  test('IM: explicitly disables channel — stages enable=false + populated fields', () => {
    // 用户显式关闭 channel 必须把 enable.envKey 持久化为 'false'，否则旧的 'true'
    // 会保留在 .env，重启后 channel 仍按默认 default 启动 — 用户在 wizard 看不到
    // 关闭意图。fields 也要保留：用户可能只想暂时停用，凭据下次再开。
    const state: WizardState = {
      providers: {},
      steps: {},
      im: { telegram: { enabled: false, fields: { token: 'tok' } } },
    };
    const m = stateToEnvKeys(state, [makeManifest('telegram')]);
    expect(m.get('GOLDPAN_IM_TELEGRAM_ENABLED')).toBe('false');
    expect(m.get('GOLDPAN_IM_TELEGRAM_TOKEN')).toBe('tok');
  });

  test('IM: untouched channel (channelState undefined) emits no envKeys', () => {
    // channelState 没出现就不写任何 IM key — 不要让 manifest 默认 default=true
    // 把没填的 channel 偷偷开启。
    const state: WizardState = { providers: {}, steps: {} };
    const m = stateToEnvKeys(state, [makeManifest('telegram')]);
    expect(m.has('GOLDPAN_IM_TELEGRAM_ENABLED')).toBe(false);
    expect(m.has('GOLDPAN_IM_TELEGRAM_TOKEN')).toBe(false);
  });

  test('IM: empty manifests means no IM env keys, even when state.im has data', () => {
    const state: WizardState = {
      providers: {},
      steps: {},
      im: { telegram: { enabled: true, fields: { token: 'tok' } } },
    };
    const m = stateToEnvKeys(state);
    for (const key of m.keys()) expect(key.startsWith('GOLDPAN_IM_')).toBe(false);
  });

  test('IM: skips fields with undefined or empty-string values', () => {
    const state: WizardState = {
      providers: {},
      steps: {},
      im: {
        telegram: {
          enabled: true,
          fields: { token: 'tok', urlTemplate: '' },
        },
      },
    };
    const m = stateToEnvKeys(state, [makeManifest('telegram')]);
    expect(m.get('GOLDPAN_IM_TELEGRAM_TOKEN')).toBe('tok');
    expect(m.has('GOLDPAN_IM_TELEGRAM_URL')).toBe(false);
  });
});

describe('stateToEnvKeys — timezone', () => {
  test('emits GOLDPAN_TIMEZONE when state.timezone is set', () => {
    const state: WizardState = { providers: {}, steps: {}, timezone: 'Asia/Shanghai' };
    const m = stateToEnvKeys(state);
    expect(m.get('GOLDPAN_TIMEZONE')).toBe('Asia/Shanghai');
  });

  test('omits GOLDPAN_TIMEZONE when state.timezone is unset', () => {
    const state: WizardState = { providers: {}, steps: {} };
    const m = stateToEnvKeys(state);
    expect(m.has('GOLDPAN_TIMEZONE')).toBe(false);
  });

  test('passes Etc/GMT-N forms through unchanged', () => {
    const state: WizardState = { providers: {}, steps: {}, timezone: 'Etc/GMT-8' };
    const m = stateToEnvKeys(state);
    expect(m.get('GOLDPAN_TIMEZONE')).toBe('Etc/GMT-8');
  });
});

describe('createCommitHandler', () => {
  test('forwards knownLlmProviderIds to wizard commit validation', async () => {
    resetWizardState();
    patchWizardState({
      steps: { classifier: { model: 'cohere:command-r-plus' } },
    });
    let forwarded: unknown;
    const handler = createCommitHandler({
      commitOverrides: async (_patch, options) => {
        forwarded = options?.knownLlmProviderIds;
        return { kind: 'ok' };
      },
      metadataRepo: {
        get: () => undefined,
        set: () => undefined,
      } as never,
      logger: { error: () => undefined },
      manifests: [],
      knownLlmProviderIds: ['cohere'],
    });
    const req = new EventEmitter() as http.IncomingMessage;
    (req as unknown as { method: string }).method = 'POST';
    (req as unknown as { resume: () => void }).resume = () => undefined;
    let status = 0;
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: () => undefined,
      setHeader: () => undefined,
      headersSent: false,
    } as unknown as http.ServerResponse;

    const done = handler(req, res);
    req.emit('end');
    await done;

    expect(status).toBe(200);
    expect(forwarded).toEqual(['cohere']);
    resetWizardState();
  });
});

describe('validateStagedBaseUrls', () => {
  // Pin the SSRF flag in staged keys so this suite is independent of whatever
  // the dev shell's process.env happens to carry.
  test('rejects private cloud-provider base URLs on commit path', async () => {
    await expect(
      validateStagedBaseUrls(
        new Map([
          ['GOLDPAN_SSRF_VALIDATION_ENABLED', 'true'],
          ['OPENAI_BASE_URL', 'http://127.0.0.1:1234/v1'],
          ['OPENAI_API_KEY', 'sk-test'],
        ]),
      ),
    ).rejects.toThrow(/private|reserved|loopback/i);
  });

  test('rejects non-loopback Ollama base URLs on commit path', async () => {
    // Ollama loopback-only is a hardcoded invariant — it must reject even
    // when the SSRF kill-switch is off.
    await expect(
      validateStagedBaseUrls(
        new Map([
          ['GOLDPAN_SSRF_VALIDATION_ENABLED', 'false'],
          ['OLLAMA_BASE_URL', 'http://169.254.169.254/v1'],
        ]),
      ),
    ).rejects.toThrow(/loopback|localhost/i);
  });

  test('SSRF kill-switch (false) lets a Fake-IP-resolved cloud base URL through', async () => {
    // Regression test for the Fake-IP user case: with the flag off, the same
    // private-IP URL that is rejected above must now be accepted, otherwise
    // the user gets stuck in the wizard.
    await expect(
      validateStagedBaseUrls(
        new Map([
          ['GOLDPAN_SSRF_VALIDATION_ENABLED', 'false'],
          ['OPENAI_BASE_URL', 'http://127.0.0.1:1234/v1'],
          ['OPENAI_API_KEY', 'sk-test'],
        ]),
      ),
    ).resolves.toBeUndefined();
  });
});
