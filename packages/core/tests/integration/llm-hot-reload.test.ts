/**
 * Integration: ConfigStore.commit('OPENAI_API_KEY', ...) → 下次 callLlm 用新 key,
 * 不需要重启 server。
 *
 * PR1 contract this test pins down:
 *   1. ConfigStore.commit 写 DB + 同步 process.env + bump generation
 *   2. createLlmRegistry 缓存 provider map by generation; 下次 languageModel()
 *      检测 generation 变化时重建
 *   3. createOpenAI 在 provider map 重建时被重新调用 → SDK 随后 lazy 读
 *      process.env.OPENAI_API_KEY 拿到新值
 *
 * 失败信号:
 *  - capturedApiKeys.at(-1) 在 commit 后仍是 baseline → registry 没 invalidate
 *    (Task 13 generation cache 失灵)
 *  - createOpenAI 只在 bootstrap 时被调一次 → registry 退回 eager 构造
 *  - commit 后 process.env.OPENAI_API_KEY 未更新 → ConfigStore.commit 没
 *    apply 到 process.env (Task 5/12)
 *
 * Mock 路径: 因为内置 openai factory `createOpenAI({ baseURL? })` 不显式传
 * apiKey, SDK 在请求时 lazy 读 process.env.OPENAI_API_KEY。createOpenAI 时
 * 不会有 apiKey 入参可抓 — 退而求其次, mock 内部读 process.env.OPENAI_API_KEY
 * 当作 "构造时刻的 baseline 值" 抓下来。等价于 "下次 createOpenAI 被调用时,
 * 它能拿到的 key 是什么"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture every apiKey that the mocked createOpenAI would resolve at construction
// time. Module-level (vi.mock 是文件级 hoist) — clear in beforeEach for
// isolation between (future) cases in this file.
const capturedApiKeys: string[] = [];

// Mock @ai-sdk/openai's createOpenAI. Forward to the real implementation so
// the returned ProviderV3 still works through createProviderRegistry /
// languageModel(). Read process.env.OPENAI_API_KEY at call time — mirrors the
// SDK's own lazy loadApiKey() inside the request headers — and push it into
// the capture array.
vi.mock('@ai-sdk/openai', async () => {
  const actual = await vi.importActual<typeof import('@ai-sdk/openai')>('@ai-sdk/openai');
  return {
    ...actual,
    createOpenAI: (opts?: { apiKey?: string; baseURL?: string }) => {
      capturedApiKeys.push(opts?.apiKey ?? process.env.OPENAI_API_KEY ?? '<none>');
      return actual.createOpenAI(opts);
    },
  };
});

// External plugin discovery is irrelevant for this test and triggers a
// dual-package-hazard (src vs dist) under integration tests — same reason
// onboarding/integration.test.ts mocks it.
vi.mock('../../src/plugins/external', () => ({
  loadExternalPlugins: vi.fn(async () => {
    /* skip in-tree plugin discovery */
  }),
}));

import { isWizardHandle } from '../../src/bootstrap';
import { resetI18n } from '../../src/i18n/index';
import { bootstrapForTest } from '../helpers/bootstrap-with-env';

let envBackup: NodeJS.ProcessEnv;

beforeEach(() => {
  envBackup = { ...process.env };
  // Wipe anything that could affect detectWizardMode / loadConfig before we
  // set the deterministic baseline below.
  const KEYS_TO_CLEAR = [
    'GOLDPAN_FORCE_WIZARD',
    'GOLDPAN_DB_SQLITE_PATH',
    'GOLDPAN_LANGUAGE',
    'GOLDPAN_AUTH_PASSWORD',
    'GOLDPAN_LLM_CLASSIFIER',
    'GOLDPAN_LLM_EXTRACTOR',
    'GOLDPAN_LLM_MATCHER',
    'GOLDPAN_LLM_COMPARATOR',
    'GOLDPAN_LLM_INTENT',
    'GOLDPAN_LLM_QUERY',
    'GOLDPAN_LLM_VERIFIER',
    'GOLDPAN_LLM_VERIFIER_ENABLED',
    'GOLDPAN_LLM_RELATOR',
    'GOLDPAN_RELATION_ENABLED',
    'GOLDPAN_DIGEST_ENABLED',
    'GOLDPAN_TRACKING_SCHEDULER_ENABLED',
    'GOLDPAN_EMBEDDING_ENABLED',
    'NODE_ENV',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
  ];
  for (const k of KEYS_TO_CLEAR) delete process.env[k];
  capturedApiKeys.length = 0;
});

afterEach(() => {
  process.env = envBackup;
});

describe('LLM hot reload — commit OPENAI_API_KEY 立刻在下次 languageModel() 生效', () => {
  it('rebuilds provider map on next languageModel() call after commit', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goldpan-llm-hotreload-'));
    const dbPath = path.join(tmp, 'goldpan.db');

    // MIN_VALID_ENV-style baseline. All 6 required LLM steps point at openai
    // so the only provider buildProviderMap eagerly references for the
    // classifier path is openai (anthropic still gets constructed because
    // digestSummary defaults to anthropic, but createAnthropic() is lazy on
    // the API key, so absence of ANTHROPIC_API_KEY doesn't throw at
    // construction).
    process.env.GOLDPAN_DB_SQLITE_PATH = dbPath;
    process.env.GOLDPAN_LANGUAGE = 'en';
    process.env.GOLDPAN_LLM_CLASSIFIER = 'openai:gpt-4o-mini';
    process.env.GOLDPAN_LLM_EXTRACTOR = 'openai:gpt-4o-mini';
    process.env.GOLDPAN_LLM_MATCHER = 'openai:gpt-4o-mini';
    process.env.GOLDPAN_LLM_COMPARATOR = 'openai:gpt-4o-mini';
    process.env.GOLDPAN_LLM_INTENT = 'openai:gpt-4o-mini';
    process.env.GOLDPAN_LLM_QUERY = 'openai:gpt-4o-mini';
    process.env.OPENAI_API_KEY = 'sk-baseline';

    resetI18n();
    const handle = await bootstrapForTest({ mode: 'normal', skipWorker: true });
    if (isWizardHandle(handle)) {
      throw new Error('expected normal-mode handle');
    }

    try {
      // Bootstrap itself does NOT eagerly call registry.languageModel
      // (resolvedCallLlm is a lazy closure). Force the first build now.
      void handle.registry.languageModel('classifier');
      // baseline should be the most recent capture — buildProviderMap may have
      // also constructed openai for the embedding/anthropic paths (it didn't,
      // but assert the latest entry corresponds to the just-issued call).
      expect(capturedApiKeys.length).toBeGreaterThanOrEqual(1);
      expect(capturedApiKeys[capturedApiKeys.length - 1]).toBe('sk-baseline');
      const beforeCommitCount = capturedApiKeys.length;

      // Commit a new OPENAI_API_KEY through ConfigStore.commit. Per Task 5/12
      // contract, this writes runtime_config_override + applyToProcessEnv +
      // bumps generation.
      const result = await handle.configStore.commit(
        new Map([['OPENAI_API_KEY', 'sk-after-commit']]),
      );
      expect(result.kind).toBe('ok');
      expect(handle.configStore.getSnapshot().generation).toBeGreaterThan(0);
      expect(process.env.OPENAI_API_KEY).toBe('sk-after-commit');

      // Next languageModel() must detect the bumped generation and rebuild
      // the provider map → mocked createOpenAI runs again → captures the
      // post-commit process.env value.
      void handle.registry.languageModel('classifier');
      expect(capturedApiKeys.length).toBeGreaterThan(beforeCommitCount);
      expect(capturedApiKeys[capturedApiKeys.length - 1]).toBe('sk-after-commit');
    } finally {
      await handle.shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
