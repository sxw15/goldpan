import type {
  ConfigSnapshot,
  ConfigStore,
  GoldpanConfig,
  SnapshotListener,
} from '@goldpan/core/config';
import type { PluginContext } from '@goldpan/core/plugins';
import type { ILogObj, Logger } from 'tslog';

/**
 * Minimal mutable ConfigStore for digest tests. Lets a test bump
 * `config.digest.dailyTime` / `config.digest.maxItemsPerModule` between
 * scheduler ticks without standing up a real DB-backed store.
 *
 * `setDigest()` mutates the snapshot AND fires onChange listeners (matching
 * the real store's commit semantics) so subscribers see the new value.
 */
export interface MutableTestConfigStore extends ConfigStore {
  setDigest(patch: Partial<GoldpanConfig['digest']>): void;
}

const SILENT_LOGGER = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
} as unknown as Logger<ILogObj>;

function defaultDigest(): GoldpanConfig['digest'] {
  return {
    enabled: true,
    dailyTime: '06:00',
    maxItemsPerModule: 10,
    linkTtlDays: 14,
  };
}

/**
 * Create a mutable test ConfigStore. Only `digest` fields are guaranteed
 * shape — the rest of `GoldpanConfig` is left as a partial cast so tests
 * don't have to populate every unrelated key. Plugins under test should
 * only read `config.digest.*` from this store.
 */
export function createMutableTestConfigStore(
  overrides: Partial<GoldpanConfig['digest']> = {},
): MutableTestConfigStore {
  const listeners = new Set<SnapshotListener>();
  let digest: GoldpanConfig['digest'] = { ...defaultDigest(), ...overrides };
  let generation = 0;

  const buildSnapshot = (): ConfigSnapshot => ({
    // `timezone` is required by plugin code that reads
    // `configStore.getSnapshot().config.timezone` (the digest service's
    // `yesterdayLocalISO()` source, postInit backfill, the future Task 7/8
    // scheduler wiring). Keep it 'UTC' for tests so existing date assertions
    // — which were written against the old `yesterdayUtcISO()` helper —
    // remain valid without per-test overrides.
    config: { digest, timezone: 'UTC' } as unknown as GoldpanConfig,
    origins: new Map(),
    generation,
  });

  let snapshot: ConfigSnapshot = buildSnapshot();

  return {
    getSnapshot: () => snapshot,
    commit: async () => ({ kind: 'ok', snapshot }),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: async () => snapshot,
    setPluginEnvKeys: () => {
      // no-op: test fixture
    },
    setDigest(patch) {
      const prev = snapshot;
      digest = { ...digest, ...patch };
      generation += 1;
      snapshot = buildSnapshot();
      // Mirror the real store's allSettled semantics: a single listener
      // throw should not abort the others or fail the test setter.
      for (const l of listeners) {
        try {
          l(snapshot, prev);
        } catch {
          // swallow
        }
      }
    },
  };
}

/**
 * Build a minimal PluginContext for digest plugin tests. Wires a mutable
 * ConfigStore (by default with `dailyTime: '06:00'` / `maxItemsPerModule: 10`)
 * so the plugin's hot-reload getters resolve at execute / tick time.
 */
export function makeTestPluginContext(overrides: Partial<GoldpanConfig['digest']> = {}): {
  context: PluginContext;
  configStore: MutableTestConfigStore;
} {
  const configStore = createMutableTestConfigStore(overrides);
  return {
    context: {
      logger: SILENT_LOGGER,
      pluginConfig: {},
      configStore,
    },
    configStore,
  };
}
