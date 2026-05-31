import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitWizardOverrides } from '../../src/config/wizard-commit.js';
import { SqliteRuntimeConfigOverrideRepository } from '../../src/db/repositories/runtime-config.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

// wizard runs when config is incomplete — strict loadConfig would throw.
// No GOLDPAN_LLM_* keys at all. Mirrors the real wizard scenario where the
// user has not yet picked any provider/model.
const PARTIAL_BOOT_ENV: NodeJS.ProcessEnv = {};

// Minimum patch the wizard would persist on commit: language + one provider key
// + the 6 LLM step models. Mirrors store.test.ts MIN_VALID_ENV but as a patch.
const MIN_VALID_PATCH: ReadonlyArray<readonly [string, string | null]> = [
  ['GOLDPAN_LANGUAGE', 'en'],
  ['OPENAI_API_KEY', 'sk-wizard'],
  ['GOLDPAN_LLM_CLASSIFIER', 'openai:gpt-4o-mini'],
  ['GOLDPAN_LLM_EXTRACTOR', 'openai:gpt-4o-mini'],
  ['GOLDPAN_LLM_MATCHER', 'openai:gpt-4o-mini'],
  ['GOLDPAN_LLM_COMPARATOR', 'openai:gpt-4o-mini'],
  ['GOLDPAN_LLM_INTENT', 'openai:gpt-4o-mini'],
  ['GOLDPAN_LLM_QUERY', 'openai:gpt-4o-mini'],
];

describe('commitWizardOverrides', () => {
  let t: TestDB;

  beforeEach(() => {
    t = createTestDB();
  });

  afterEach(() => {
    t.cleanup();
  });

  it('persists patch to DB', async () => {
    const result = await commitWizardOverrides(t.db, new Map(MIN_VALID_PATCH), {
      bootEnv: PARTIAL_BOOT_ENV,
    });
    expect(result.kind).toBe('ok');

    const repo = new SqliteRuntimeConfigOverrideRepository(t.db);
    expect(repo.list().get('OPENAI_API_KEY')).toBe('sk-wizard');
    expect(repo.list().get('GOLDPAN_LANGUAGE')).toBe('en');
  });

  it('rejects keys outside whitelist', async () => {
    const result = await commitWizardOverrides(t.db, new Map([['UNKNOWN_KEY', 'x']]), {
      bootEnv: PARTIAL_BOOT_ENV,
    });
    expect(result.kind).toBe('errors');
  });

  it('does NOT mutate process.env', async () => {
    const before = process.env.OPENAI_API_KEY;
    await commitWizardOverrides(
      t.db,
      new Map([...MIN_VALID_PATCH, ['OPENAI_API_KEY', 'sk-should-not-leak']]),
      { bootEnv: PARTIAL_BOOT_ENV },
    );
    expect(process.env.OPENAI_API_KEY).toBe(before);
  });
});
