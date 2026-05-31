import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
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

describe('createConfigStore — construction', () => {
  let t: TestDB;

  beforeEach(() => {
    t = createTestDB();
  });

  afterEach(() => {
    t.cleanup();
  });

  it('snapshot.config matches loadConfig(bootEnv) when DB is empty', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });
    const snap = store.getSnapshot();
    expect(snap.config.language).toBe('en');
    expect(snap.config.llm.classifier).toBe('openai:gpt-4o-mini');
    expect(snap.generation).toBe(0);
  });

  it('origins reports "env" for keys present in bootEnv', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });
    const { origins } = store.getSnapshot();
    expect(origins.get('OPENAI_API_KEY')).toBe('env');
    expect(origins.get('GOLDPAN_LLM_CLASSIFIER')).toBe('env');
  });

  it('origins reports "default" for managed keys absent from bootEnv', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });
    const { origins } = store.getSnapshot();
    // ANTHROPIC_API_KEY is in MANAGED_ENV_KEYS but not in our bootEnv.
    expect(origins.get('ANTHROPIC_API_KEY')).toBe('default');
  });
});

describe('ConfigStore.commit — happy path', () => {
  let t: TestDB;

  beforeEach(() => {
    t = createTestDB();
  });

  afterEach(() => {
    t.cleanup();
  });

  it('upserts override, snapshot reflects new value, generation bumps', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });
    const before = store.getSnapshot();
    expect(before.generation).toBe(0);
    expect(before.config.llm.classifier).toBe('openai:gpt-4o-mini');

    const result = await store.commit(new Map([['GOLDPAN_LLM_CLASSIFIER', 'openai:gpt-4o']]));
    expect(result.kind).toBe('ok');

    const after = store.getSnapshot();
    expect(after.generation).toBe(1);
    expect(after.config.llm.classifier).toBe('openai:gpt-4o');
    expect(after.origins.get('GOLDPAN_LLM_CLASSIFIER')).toBe('override');
  });

  it('null value deletes override, origin returns to env', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });
    await store.commit(new Map([['GOLDPAN_LLM_CLASSIFIER', 'openai:gpt-4o']]));
    expect(store.getSnapshot().origins.get('GOLDPAN_LLM_CLASSIFIER')).toBe('override');

    const result = await store.commit(new Map([['GOLDPAN_LLM_CLASSIFIER', null]]));
    expect(result.kind).toBe('ok');
    const snap = store.getSnapshot();
    expect(snap.origins.get('GOLDPAN_LLM_CLASSIFIER')).toBe('env');
    expect(snap.config.llm.classifier).toBe('openai:gpt-4o-mini'); // baseline
    expect(snap.generation).toBe(2);
  });

  it('onChange listeners receive (new, prev)', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });
    const calls: { new: number; prev: number }[] = [];
    store.onChange((newSnap, prevSnap) => {
      calls.push({ new: newSnap.generation, prev: prevSnap.generation });
    });
    await store.commit(new Map([['GOLDPAN_LLM_CLASSIFIER', 'openai:gpt-4o']]));
    await store.commit(new Map([['OPENAI_API_KEY', 'sk-test-2']]));
    expect(calls).toEqual([
      { new: 1, prev: 0 },
      { new: 2, prev: 1 },
    ]);
  });

  it('listener throwing does not block other listeners or fail commit', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });
    const seen: number[] = [];
    store.onChange(() => {
      throw new Error('boom');
    });
    store.onChange((snap) => {
      seen.push(snap.generation);
    });
    const result = await store.commit(new Map([['GOLDPAN_LLM_CLASSIFIER', 'openai:gpt-4o']]));
    expect(result.kind).toBe('ok');
    expect(seen).toEqual([1]);
  });
});

describe('ConfigStore.commit — failure modes', () => {
  let t: TestDB;

  beforeEach(() => {
    t = createTestDB();
  });

  afterEach(() => {
    t.cleanup();
  });

  it('rejects key outside whitelist', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });
    const result = await store.commit(new Map([['UNKNOWN_KEY', 'whatever']]));
    expect(result.kind).toBe('errors');
    if (result.kind === 'errors') {
      expect(result.errors[0].path).toBe('UNKNOWN_KEY');
    }
    // No-op on DB.
    expect(store.getSnapshot().generation).toBe(0);
  });

  it('rejects when validateStagedConfig fails', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });
    // Send a malformed model id — loadConfig zod will reject the shape.
    const result = await store.commit(new Map([['GOLDPAN_LLM_CLASSIFIER', 'no-colon-here']]));
    expect(result.kind).toBe('errors');
    expect(store.getSnapshot().generation).toBe(0);
  });

  it('plugin envSchema failure — clean error path', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      pluginEnvKeys: ['GOLDPAN_PLUGIN_FOO'],
      logger: SILENT_LOGGER,
    });
    const fooSchema = { GOLDPAN_PLUGIN_FOO: z.enum(['a', 'b']) };
    const result = await store.commit(new Map([['GOLDPAN_PLUGIN_FOO', 'c']]), {
      pluginEnvSchemas: [fooSchema],
    });
    expect(result.kind).toBe('errors');
  });

  it('concurrent commits serialize (no lost-update)', async () => {
    const store = await createConfigStore({
      db: t.db,
      bootEnv: MIN_VALID_ENV,
      applyToProcessEnv: false,
      logger: SILENT_LOGGER,
    });
    const transitions: { prev: number; new: number }[] = [];
    store.onChange((newSnap, prevSnap) => {
      transitions.push({ prev: prevSnap.generation, new: newSnap.generation });
    });
    const [r1, r2] = await Promise.all([
      store.commit(new Map([['GOLDPAN_LLM_CLASSIFIER', 'openai:gpt-4o']])),
      store.commit(new Map([['OPENAI_API_KEY', 'sk-test-second']])),
    ]);
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    const snap = store.getSnapshot();
    expect(snap.generation).toBe(2);
    expect(snap.config.llm.classifier).toBe('openai:gpt-4o');
    // Listener transitions must be strictly monotonic — without withCommitLock,
    // generation-bump / listener-fire ordering between concurrent commits can
    // interleave and produce e.g. [{prev:0,new:1},{prev:0,new:2}].
    expect(transitions).toEqual([
      { prev: 0, new: 1 },
      { prev: 1, new: 2 },
    ]);
  });
});

describe('ConfigStore — process.env sync precision', () => {
  let t: TestDB;

  beforeEach(() => {
    t = createTestDB();
  });

  afterEach(() => {
    t.cleanup();
  });

  // Save / restore process.env around each test so we don't leak state.
  const PRESERVED = ['OPENAI_API_KEY', 'GOLDPAN_LLM_CLASSIFIER', 'PATH', 'NODE_OPTIONS'];

  function snapshotEnv(): Record<string, string | undefined> {
    return Object.fromEntries(PRESERVED.map((k) => [k, process.env[k]]));
  }
  function restoreEnv(snap: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(snap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it('mutates only managed keys, never PATH / NODE_OPTIONS', async () => {
    const before = snapshotEnv();
    process.env.PATH = '/should/not/change';
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOLDPAN_LLM_CLASSIFIER;
    try {
      const store = await createConfigStore({
        db: t.db,
        bootEnv: MIN_VALID_ENV,
        applyToProcessEnv: true, // exercise the real path
        logger: SILENT_LOGGER,
      });
      // Construction sync.
      expect(process.env.OPENAI_API_KEY).toBe('sk-test-baseline');
      expect(process.env.PATH).toBe('/should/not/change');
      expect(process.env.NODE_OPTIONS).toBe('--max-old-space-size=4096');

      await store.commit(new Map([['OPENAI_API_KEY', 'sk-after-commit']]));
      expect(process.env.OPENAI_API_KEY).toBe('sk-after-commit');
      expect(process.env.PATH).toBe('/should/not/change');
      expect(process.env.NODE_OPTIONS).toBe('--max-old-space-size=4096');

      // Delete override → process.env returns to bootEnv value.
      await store.commit(new Map([['OPENAI_API_KEY', null]]));
      expect(process.env.OPENAI_API_KEY).toBe('sk-test-baseline');
    } finally {
      restoreEnv(before);
    }
  });

  it('applyToProcessEnv: false leaves process.env untouched', async () => {
    const before = snapshotEnv();
    process.env.OPENAI_API_KEY = 'live-value';
    try {
      const store = await createConfigStore({
        db: t.db,
        bootEnv: MIN_VALID_ENV,
        applyToProcessEnv: false,
        logger: SILENT_LOGGER,
      });
      await store.commit(new Map([['OPENAI_API_KEY', 'sk-from-store']]));
      expect(process.env.OPENAI_API_KEY).toBe('live-value');
      // But snapshot still reflects the override.
      expect(store.getSnapshot().origins.get('OPENAI_API_KEY')).toBe('override');
    } finally {
      restoreEnv(before);
    }
  });
});
