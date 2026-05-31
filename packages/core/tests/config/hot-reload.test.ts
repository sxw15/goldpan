import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConfigStore } from '../../src/config/store.js';
import { createRootLogger } from '../../src/logger/index.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

const SILENT_LOGGER = createRootLogger('error');

const MIN_VALID_ENV: NodeJS.ProcessEnv = {
  GOLDPAN_LANGUAGE: 'en',
  GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_EXTRACTOR: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_MATCHER: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_COMPARATOR: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_INTENT: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_QUERY: 'openai:gpt-4o-mini',
  OPENAI_API_KEY: 'sk-test-baseline',
};

// The content-length limits drive the `content_length` errorKind in the
// collecting/entry gates. They must be HOT — a `commit` has to update the live
// snapshot WITHOUT recreating the store / restarting the process. These tests
// pin that: read defaults, commit a new value, assert the same store's snapshot
// reflects it. A regression to "needs restart" would otherwise be invisible
// (the env-baseline path would still pass on a fresh boot).
describe('ConfigStore — content-length limits are hot (no restart)', () => {
  let t: TestDB;

  beforeEach(() => {
    t = createTestDB();
  });

  afterEach(() => {
    t.cleanup();
  });

  it('GOLDPAN_MAX_TEXT_INPUT_LENGTH commit updates the live snapshot', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });

    // Default baseline (config/index.ts).
    expect(store.getSnapshot().config.maxTextInputLength).toBe(20000);

    // 12345 ≤ default maxContent (30000) — satisfies maxText ≤ maxContent.
    const result = await store.commit(new Map([['GOLDPAN_MAX_TEXT_INPUT_LENGTH', '12345']]));
    expect(result.kind).toBe('ok');

    // Same store instance — proves the snapshot is live, not boot-frozen.
    expect(store.getSnapshot().config.maxTextInputLength).toBe(12345);
    expect(store.getSnapshot().origins.get('GOLDPAN_MAX_TEXT_INPUT_LENGTH')).toBe('override');
  });

  it('GOLDPAN_MAX_CONTENT_LENGTH commit updates the live snapshot', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });

    expect(store.getSnapshot().config.maxContentLength).toBe(30000);

    // 40000 ≥ default maxText (20000) and ≥ default minContent (50).
    const result = await store.commit(new Map([['GOLDPAN_MAX_CONTENT_LENGTH', '40000']]));
    expect(result.kind).toBe('ok');

    expect(store.getSnapshot().config.maxContentLength).toBe(40000);
    expect(store.getSnapshot().origins.get('GOLDPAN_MAX_CONTENT_LENGTH')).toBe('override');
  });

  it('GOLDPAN_MIN_CONTENT_LENGTH commit updates the live snapshot', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });

    expect(store.getSnapshot().config.minContentLength).toBe(50);

    // 100 ≤ default maxContent (30000) — satisfies minContent ≤ maxContent.
    const result = await store.commit(new Map([['GOLDPAN_MIN_CONTENT_LENGTH', '100']]));
    expect(result.kind).toBe('ok');

    expect(store.getSnapshot().config.minContentLength).toBe(100);
  });

  it('both limits commit together; accumulated overrides keep the cross-field invariant', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });

    // Raise maxContent first so the later maxText still satisfies maxText ≤ maxContent.
    const r1 = await store.commit(new Map([['GOLDPAN_MAX_CONTENT_LENGTH', '60000']]));
    expect(r1.kind).toBe('ok');
    const r2 = await store.commit(new Map([['GOLDPAN_MAX_TEXT_INPUT_LENGTH', '50000']]));
    expect(r2.kind).toBe('ok');

    const snap = store.getSnapshot();
    expect(snap.config.maxContentLength).toBe(60000);
    expect(snap.config.maxTextInputLength).toBe(50000);
    // Two commits → generation advanced twice (live, not reset by re-read).
    expect(snap.generation).toBe(2);
  });
});
