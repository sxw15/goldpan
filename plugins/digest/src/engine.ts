import type { DrizzleDB } from '@goldpan/core/db';
import { errorMessage } from '@goldpan/core/errors';
import type { ServiceCallLlmFn } from '@goldpan/core/plugins';
import type { ILogObj, Logger } from 'tslog';
import { generateAiSummary } from './modules/ai-summary.js';
import {
  collectCaptures,
  collectNewEntities,
  collectStats,
  collectThoughts,
  collectTrackingFindings,
  type DateRange,
} from './modules/index.js';
import type {
  CapturesModule,
  DataSnapshot,
  DigestId,
  GenerateResult,
  ModuleData,
  NewEntitiesModule,
  Period,
  StatsModule,
  ThoughtsModule,
  TrackingFindingsModule,
} from './types.js';

export interface DigestEngineSnapshotInfo {
  digestId: DigestId;
  period: Period;
  range: DateRange;
  /**
   * Whether phase-1 module data may be cached after generation. Rolling windows
   * are anchored at generation time, so they must not reuse a prior module
   * snapshot after the in-flight request has completed.
   */
  cacheable?: boolean;
}

export interface DigestEngineOptions {
  db: DrizzleDB;
  /**
   * Per-module item cap. A getter (NOT a captured number) so runtime
   * `commit()` of `GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE` takes effect on the
   * next digest generation without restart. The plugin wires this to
   * `() => configStore.getSnapshot().config.digest.maxItemsPerModule`.
   */
  getMaxItemsPerModule: () => number;
  getSnapshot: (id: DigestId) => Promise<DigestEngineSnapshotInfo>;
  language?: 'en' | 'zh';
  callLlm?: ServiceCallLlmFn;
  /**
   * Optional tslog logger used to surface module-collection failures. Without
   * it, the partial-snapshot fallback is silent (P1-1 shim). Callers running
   * under the plugin harness should forward `PluginContext.logger`.
   */
  logger?: Logger<ILogObj>;
}

export interface GenerateOptions {
  includeAiSummary: boolean;
  forceRegenerate?: boolean;
}

type Phase1Modules = DataSnapshot['modules'];

interface Phase1Entry {
  modules: Phase1Modules;
  generatedAt: number;
  period: Period;
}

/** Long enough to cover same-day re-renders + next-day comparison snapshots, short
 * enough that a long-running server (weeks of uptime × N channels × M presets)
 * doesn't accumulate stale module collections in memory. */
const PHASE1_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cache identity for the phase-1 module collection. Includes the per-module
 * cap so that a runtime `commit()` of `GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE`
 * naturally misses the cache and triggers a fresh `collectModules` call —
 * without `maxItems` in the key the cached entry would freeze the user's old
 * cap forever (until `forceRegenerate` or the 7-day prune), even though
 * `collectModules` itself reads the latest cap on every call. Found in
 * review H-2 (PR #47): the hot-reload test only covered `forceRegenerate`,
 * so the cached path was silently stuck on boot values.
 */
function digestKey(
  id: DigestId,
  maxItemsPerModule: number,
  info: DigestEngineSnapshotInfo,
): string {
  const rangeKey =
    info.cacheable === false ? 'volatile' : `${info.period}|${info.range.from}|${info.range.to}`;
  return `${id.channel}|${id.date}|${id.presetId ?? 'null'}|max=${maxItemsPerModule}|${rangeKey}`;
}

function emptyModules(): Phase1Modules {
  const emptyTracking: TrackingFindingsModule = {
    type: 'tracking_findings',
    items: [],
    hasMore: false,
    hiddenCount: 0,
  };
  const emptyCaptures: CapturesModule = {
    type: 'captures',
    items: [],
    hasMore: false,
    hiddenCount: 0,
  };
  const emptyThoughts: ThoughtsModule = {
    type: 'thoughts',
    items: [],
    hasMore: false,
    hiddenCount: 0,
  };
  const emptyEntities: NewEntitiesModule = {
    type: 'new_entities',
    items: [],
    hasMore: false,
    hiddenCount: 0,
  };
  const emptyStats: StatsModule = {
    type: 'stats',
    captures: 0,
    findings: 0,
    thoughts: 0,
    entities: 0,
  };
  return {
    tracking_findings: emptyTracking,
    captures: emptyCaptures,
    thoughts: emptyThoughts,
    new_entities: emptyEntities,
    stats: emptyStats,
  };
}

export class DigestEngine {
  private readonly options: DigestEngineOptions;
  private readonly inFlight = new Map<string, Promise<GenerateResult>>();
  private readonly phase1Cache = new Map<string, Phase1Entry>();

  constructor(options: DigestEngineOptions) {
    this.options = options;
  }

  async generate(id: DigestId, opts: GenerateOptions): Promise<GenerateResult> {
    // Resolve the cap once per call so the cache key matches what
    // `collectModules` will see if we end up running it. A separate read
    // inside `collectModules` is fine — the value is the same within one
    // call, and the per-call cost of two `getSnapshot()` reads is trivial.
    const maxItemsPerModule = this.options.getMaxItemsPerModule();
    const info = await this.options.getSnapshot(id);
    const cacheable = info.cacheable !== false;
    const key = digestKey(id, maxItemsPerModule, info);
    const force = opts.forceRegenerate === true;

    if (!force) {
      const cached = cacheable ? this.phase1Cache.get(key) : undefined;
      if (cached && !opts.includeAiSummary) {
        return {
          snapshot: {
            digestId: id,
            period: cached.period,
            generatedAt: cached.generatedAt,
            modules: cached.modules,
            aiSummary: { status: 'fallback', text: '' },
          },
          status: 'complete',
        };
      }
      const existing = this.inFlight.get(key);
      if (existing) return existing;
    }

    const promise = this.runGenerate(id, opts, key, info, cacheable);
    if (!force) this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    }
  }

  private async runGenerate(
    id: DigestId,
    opts: GenerateOptions,
    key: string,
    info: DigestEngineSnapshotInfo,
    cacheable: boolean,
  ): Promise<GenerateResult> {
    const cached = !opts.forceRegenerate && cacheable ? this.phase1Cache.get(key) : undefined;

    let modules: Phase1Modules;
    let status: 'complete' | 'partial' = 'complete';

    if (cached) {
      modules = cached.modules;
    } else {
      try {
        modules = await this.collectModules(info.range);
      } catch (err) {
        this.options.logger?.warn('digest module collection failed — returning partial snapshot', {
          digestId: id,
          error: errorMessage(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        modules = emptyModules();
        status = 'partial';
      }
    }

    const generatedAt = Date.now();
    if (cacheable && status === 'complete' && !cached) {
      this.prunePhase1Cache(generatedAt);
      this.phase1Cache.set(key, { modules, generatedAt, period: info.period });
    }

    const snapshotWithoutSummary: Omit<DataSnapshot, 'aiSummary'> = {
      digestId: id,
      period: info.period,
      generatedAt,
      modules,
    };

    const aiSummary = opts.includeAiSummary
      ? await generateAiSummary(snapshotWithoutSummary, {
          language: this.options.language ?? 'en',
          callLlm: this.options.callLlm,
        })
      : ({ status: 'fallback', text: '' } as DataSnapshot['aiSummary']);

    return {
      snapshot: { ...snapshotWithoutSummary, aiSummary },
      status,
    };
  }

  private async collectModules(range: DateRange): Promise<Phase1Modules> {
    const { db, getMaxItemsPerModule } = this.options;
    // Read fresh per-call so runtime config commits hot-reload without restart.
    const maxItemsPerModule = getMaxItemsPerModule();
    return {
      tracking_findings: collectTrackingFindings(db, range, maxItemsPerModule),
      captures: collectCaptures(db, range, maxItemsPerModule),
      thoughts: collectThoughts(db, range, maxItemsPerModule),
      new_entities: collectNewEntities(db, range, maxItemsPerModule),
      stats: collectStats(db, range),
    };
  }

  private prunePhase1Cache(now: number): void {
    const cutoff = now - PHASE1_MAX_AGE_MS;
    for (const [key, entry] of this.phase1Cache) {
      if (entry.generatedAt < cutoff) this.phase1Cache.delete(key);
    }
  }
}

export type { ModuleData };
