/**
 * End-to-end integration test for the onboarding wizard happy path.
 *
 * Wires together the building blocks the wizard server's commit handler
 * uses (`detectWizardMode`, `validateStagedConfig`, `wizardHandle.commitOverrides`,
 * `applyMetadata`) plus `bootstrap()` so a contract change in any one of them
 * that breaks the wizard → normal-mode handoff fails this test.
 *
 * Not a UI / HTTP test — drives the same primitives a Node restart would.
 *
 * PR1 contract: wizard writes runtime overrides to DB (NOT `.env`); the next
 * normal-mode `bootstrap()` reads them via `ConfigStore` (bootEnv ⊕ DB
 * override). The user does not need to hand-edit `.env` between wizard
 * commit and restart — that's the core PR1 win this test pins down.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// External plugins (`monorepo/plugins/*/dist/index.js`) re-import `@goldpan/core`
// through the package's `import` condition (→ `dist/*.mjs`), but this test
// imports `bootstrap` from `src/`. The two paths produce DIFFERENT module
// instances of `db/connection.ts` — each with its own `rawDbMap` WeakMap —
// so a plugin's `getRawDatabase(db)` returns undefined and tracking's
// `ensureTrackingTables` blows up. The plugin loader is the only way an
// integration test gets to a "fresh" full bootstrap from src; mock it to a
// no-op so this test exercises the wizard ↔ normal-mode handoff (the
// contract we actually care about) without dragging in a dual-package-hazard
// fix that's out of scope for M1.
vi.mock('../../src/plugins/external', () => ({
  loadExternalPlugins: vi.fn(async () => {
    /* skip in-tree plugin discovery */
  }),
}));

import { isWizardHandle } from '../../src/bootstrap';
import { SqliteMetadataRepository } from '../../src/db/repositories/metadata';
import { resetI18n } from '../../src/i18n/index';
import { applyMetadata, validateStagedConfig } from '../../src/onboarding';
import { detectWizardMode } from '../../src/onboarding/wizard-mode';
import { bootstrapForTest } from '../helpers/bootstrap-with-env';

/**
 * Process-env keys that any of the integration scenarios touch. Captured in
 * `beforeEach` and restored in `afterEach` so a test cannot leak globals into
 * its neighbors. Vitest runs tests serially in a single worker so a stable
 * snapshot/restore is sufficient — no cross-thread races.
 *
 * We capture the **whole** `process.env` rather than a key allow-list because
 * `validateStagedConfig` and `loadConfig()` consume the full env, and a stray
 * `GOLDPAN_*` knob from the dev shell could mask an assertion (e.g. a non-
 * default `GOLDPAN_OUTPUT_FULL_THRESHOLD` flipping a cross-field check).
 */
let envBackup: NodeJS.ProcessEnv;

beforeEach(() => {
  envBackup = { ...process.env };
  // Wipe wizard-managed keys plus the cross-field knobs `validate.test.ts`
  // sanitizes — anything `loadConfig` checks should start unset so we drive
  // the env explicitly per scenario.
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
    'GOLDPAN_OUTPUT_FULL_THRESHOLD',
    'GOLDPAN_OUTPUT_INCREMENT_THRESHOLD',
    'NODE_ENV',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
  ];
  for (const k of KEYS_TO_CLEAR) delete process.env[k];
});

afterEach(() => {
  process.env = envBackup;
});

describe('onboarding integration', () => {
  test('fresh DB → no env → wizard detected → wizardHandle.commitOverrides → restart normal mode reads DB overrides', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-int-fresh-'));
    const dbPath = path.join(tmp, 'goldpan.db');

    let wizardHandle: Awaited<ReturnType<typeof bootstrapForTest>> | undefined;
    let normalHandle: Awaited<ReturnType<typeof bootstrapForTest>> | undefined;
    try {
      // 1. Fresh state — no provider keys. Defaults reference openai+anthropic
      //    so detectWizardMode flags `no_provider_key`.
      const reasonBefore = detectWizardMode();
      expect(reasonBefore).not.toBeNull();
      expect(reasonBefore?.kind).toBe('no_provider_key');

      // 2. Boot wizard mode — DB created/migrated; wizard handle returns the
      //    commitOverrides closure that writes runtime overrides to the
      //    runtime_config_override table (NOT `.env`).
      process.env.GOLDPAN_DB_SQLITE_PATH = dbPath; // both bootstraps share DB
      wizardHandle = await bootstrapForTest({ mode: 'wizard' });
      expect(isWizardHandle(wizardHandle)).toBe(true);
      if (!isWizardHandle(wizardHandle)) {
        throw new Error('expected wizard-mode handle');
      }

      // 3. Stage the same shape an 8-page wizard would commit
      //    (language + provider keys + LLM models). Sanity-validate the
      //    syntactic shape with `validateStagedConfig` before persisting —
      //    `commitOverrides` runs its own `validateStaged` internally, but
      //    the static check up front mirrors what the wizard route does
      //    (early bail on malformed input before touching the DB).
      const staged: Record<string, string> = {
        GOLDPAN_LANGUAGE: 'zh',
        GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
        GOLDPAN_LLM_EXTRACTOR: 'anthropic:claude-sonnet-4-20250514',
        GOLDPAN_LLM_MATCHER: 'anthropic:claude-sonnet-4-20250514',
        GOLDPAN_LLM_COMPARATOR: 'anthropic:claude-sonnet-4-20250514',
        GOLDPAN_LLM_INTENT: 'openai:gpt-4o-mini',
        GOLDPAN_LLM_QUERY: 'anthropic:claude-sonnet-4-20250514',
        OPENAI_API_KEY: 'sk-test-openai',
        ANTHROPIC_API_KEY: 'sk-test-anthropic',
      };
      const validation = validateStagedConfig(staged);
      expect(validation.ok).toBe(true);

      // 4. Persist via commitOverrides — writes to runtime_config_override.
      //    No `.env` is touched. The PR1 contract: this alone is enough for
      //    the next bootstrap to recover normal mode.
      const stagedMap = new Map(Object.entries(staged));
      const commitResult = await wizardHandle.commitOverrides(stagedMap);
      expect(commitResult.kind).toBe('ok');

      // 5. Shutdown wizard before re-bootstrapping. The wizard handle owns
      //    the SQLite connection — production restart drops it (process.exit)
      //    and the new boot opens its own. Skipping this shutdown leaves two
      //    handles racing on the same DB file.
      await wizardHandle.shutdown();
      wizardHandle = undefined;

      // 6. Restart in normal mode. process.env still has NO provider keys —
      //    that's the PR1 invariant: the user doesn't hand-edit `.env`
      //    between wizard commit and restart. `bootstrap()` reads the DB
      //    overrides through `ConfigStore`, merges with the empty bootEnv,
      //    and produces a healthy snapshot. `mode: 'normal'` would throw if
      //    the merge missed any required key.
      //
      //    `skipWorker: true` keeps the recursive setTimeout from staying
      //    live past the test.
      //
      //    `resetI18n()` first because `tests/helpers/i18n.ts` pre-initializes
      //    the singleton to 'en' before every test; bootstrap will call
      //    `initI18n('zh')` (driven by GOLDPAN_LANGUAGE override) which
      //    throws on the pre-existing 'en' singleton. Production never hits
      //    this — there's only one `initI18n` per process boot.
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      resetI18n();
      normalHandle = await bootstrapForTest({ mode: 'normal', skipWorker: true });
      expect(isWizardHandle(normalHandle)).toBe(false);
      if (isWizardHandle(normalHandle)) {
        throw new Error('expected normal-mode handle');
      }
      // Snapshot must reflect the staged values that came from DB override.
      // Use `configStore.getSnapshot()` not `handle.config` so the assertion
      // exercises the live path the rest of the runtime reads from after
      // hot-reload.
      const snapshot = normalHandle.configStore.getSnapshot().config;
      expect(snapshot.llm.classifier).toBe('openai:gpt-4o-mini');
      expect(snapshot.llm.extractor).toBe('anthropic:claude-sonnet-4-20250514');
      expect(snapshot.language).toBe('zh');
      expect(snapshot.db.sqlitePath).toBe(dbPath);
    } finally {
      // Shutdown BEFORE rmSync — better-sqlite3 holds an OS file handle on
      // the .db, and rm fails on Windows / certain Linux FS configs if the
      // handle is still open. The non-Windows mac/linux dev path tolerates
      // it but CI would not.
      if (wizardHandle) await wizardHandle.shutdown();
      if (normalHandle) await normalHandle.shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test('wizard handle → commitOverrides → shutdown → restart auto mode → normal handle', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-int-restart-'));
    const dbPath = path.join(tmp, 'goldpan.db');

    // Both bootstraps share the same DB so the runtime overrides written by
    // the wizard can be read by the normal-mode boot — that's the actual
    // restart contract.
    process.env.GOLDPAN_DB_SQLITE_PATH = dbPath;

    let wizardHandle: Awaited<ReturnType<typeof bootstrapForTest>> | undefined;
    let normalHandle: Awaited<ReturnType<typeof bootstrapForTest>> | undefined;
    try {
      // 1. Force wizard mode — the user is configuring a fresh deploy. DB
      //    gets created and migrated as a side effect; commitOverrides is
      //    the channel the wizard's commit step writes through.
      wizardHandle = await bootstrapForTest({ mode: 'wizard' });
      expect(isWizardHandle(wizardHandle)).toBe(true);
      if (!isWizardHandle(wizardHandle)) {
        throw new Error('expected wizard-mode handle');
      }
      expect(wizardHandle.reason.kind).toBe('forced');

      // 2. Persist provider keys + LLM models via commitOverrides. Writes
      //    to runtime_config_override; `.env` is never touched.
      const staged = new Map<string, string>([
        ['GOLDPAN_LLM_CLASSIFIER', 'openai:gpt-4o-mini'],
        ['GOLDPAN_LLM_EXTRACTOR', 'anthropic:claude-sonnet-4-20250514'],
        ['OPENAI_API_KEY', 'sk-test-openai'],
        ['ANTHROPIC_API_KEY', 'sk-test-anthropic'],
      ]);
      const commitResult = await wizardHandle.commitOverrides(staged);
      expect(commitResult.kind).toBe('ok');

      // 3. Shutdown the wizard handle before re-bootstrapping. The wizard
      //    handle owns the SQLite connection — the production restart drops
      //    it (process.exit) and the new boot opens its own. Skipping this
      //    shutdown leaves two handles racing on the same DB file and the
      //    second `createDatabase` would fail with SQLITE_BUSY in some
      //    drivers.
      await wizardHandle.shutdown();
      wizardHandle = undefined;

      // 4. Clear the FORCE flag so auto-detect runs through the real code path.
      delete process.env.GOLDPAN_FORCE_WIZARD;

      // 5. Boot in 'auto' mode — bootstrap merges bootEnv ⊕ DB overrides
      //    when running detectWizardMode, sees the OPENAI_API_KEY override,
      //    and falls through to normal mode. process.env still has NO
      //    provider keys — that's the PR1 win.
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      resetI18n();
      normalHandle = await bootstrapForTest({ mode: 'auto', skipWorker: true });
      expect(isWizardHandle(normalHandle)).toBe(false);
      if (isWizardHandle(normalHandle)) {
        throw new Error('expected normal-mode handle on second boot');
      }
      expect(normalHandle.configStore.getSnapshot().config.llm.classifier).toBe(
        'openai:gpt-4o-mini',
      );
    } finally {
      if (wizardHandle) await wizardHandle.shutdown();
      if (normalHandle) await normalHandle.shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test('applyMetadata via wizard handle persists language; normal-mode bootstrap honors GOLDPAN_LANGUAGE', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-int-meta-'));
    const dbPath = path.join(tmp, 'goldpan.db');
    process.env.GOLDPAN_DB_SQLITE_PATH = dbPath;

    let wizardHandle: Awaited<ReturnType<typeof bootstrapForTest>> | undefined;
    let normalHandle: Awaited<ReturnType<typeof bootstrapForTest>> | undefined;
    try {
      // 1. Wizard mode owns the DB — wizard server's commit handler uses
      //    `handle.metadataRepo` as the seed channel for language, digest
      //    presets, and tracking rules.
      wizardHandle = await bootstrapForTest({ mode: 'wizard' });
      if (!isWizardHandle(wizardHandle)) {
        throw new Error('expected wizard-mode handle');
      }

      // 2. Drive `applyMetadata` through the wizard handle's metadataRepo.
      //    Writes `db.language` — same key `resolveLanguageLock` reads on
      //    every normal-mode boot. Earlier drafts wrote a bare `'language'`
      //    key that no consumer read; that branch is gone.
      applyMetadata(wizardHandle.metadataRepo, { language: 'zh' });

      // Direct check via a fresh repo over the same DrizzleDB instance.
      // Confirms the metadataRepo handed off to wizard callers is the same
      // one that bootstrap will see post-restart, and that applyMetadata
      // didn't no-op silently.
      const readback = new SqliteMetadataRepository(wizardHandle.db);
      expect(readback.get('db.language')).toBe('zh');
      expect(readback.get('language')).toBeUndefined();

      // 3. Shutdown wizard, set provider keys + GOLDPAN_LANGUAGE, restart
      //    normal-mode against the same DB. `commit.ts` writes BOTH the
      //    env var (GOLDPAN_LANGUAGE) AND the metadata seed (applyMetadata)
      //    on commit, so the env var is what drives `config.language`. The
      //    wizard-written `db.language` seed matches what
      //    `resolveLanguageLock` would have written on first normal-mode
      //    boot, so the lock is "pre-armed" without needing a second pass.
      await wizardHandle.shutdown();
      wizardHandle = undefined;

      process.env.OPENAI_API_KEY = 'sk-test-openai';
      process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
      process.env.GOLDPAN_LLM_CLASSIFIER = 'openai:gpt-4o-mini';
      process.env.GOLDPAN_LLM_EXTRACTOR = 'anthropic:claude-sonnet-4-20250514';
      process.env.GOLDPAN_LANGUAGE = 'zh';

      resetI18n();
      normalHandle = await bootstrapForTest({ mode: 'auto', skipWorker: true });
      if (isWizardHandle(normalHandle)) {
        throw new Error('expected normal-mode handle');
      }
      // Both pathways agree: env-driven config.language is 'zh', and the
      // wizard-written metadata seed (db.language) is the same key
      // resolveLanguageLock reads — it sees the existing value, no rewrite.
      expect(normalHandle.config.language).toBe('zh');
      expect(normalHandle.repos.metadata.get('db.language')).toBe('zh');
      expect(normalHandle.repos.metadata.get('language')).toBeUndefined();
    } finally {
      if (wizardHandle) await wizardHandle.shutdown();
      if (normalHandle) await normalHandle.shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
