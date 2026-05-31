import type { DrizzleDB } from '@goldpan/core/db';
import { errorMessage } from '@goldpan/core/errors';
import type {
  IntentDeclaration,
  IntentExecutionContext,
  IntentPlugin,
  IntentPluginResult,
  IntentSessionRef,
  PluginContext,
  PluginSettingsContribution,
  ServiceCallLlmFn,
  ServiceCapabilities,
} from '@goldpan/core/plugins';
import { z } from 'zod';
import { ensureDigestTables, resetCrashedDigestState } from './db.js';
import { DigestEngine } from './engine.js';
import { parseDigestAction } from './im/action-parser.js';
import { handleDigestAction } from './im/handler.js';
import { parseSessionKey } from './im/session-key.js';
import { disabledContent, handleDigestQuery, validatePrompts } from './intent-handler.js';
import type { DateRange } from './modules/index.js';
import { computeDigestRange, yesterdayLocalISO } from './render/helpers.js';
import { renderIMDigest } from './render/im.js';
import { backfillMissing } from './schedulers/backfill.js';
import { createDataSnapshotScheduler, type SchedulerHandle } from './schedulers/data-snapshot.js';
import { createPushScheduler, type PushHandle } from './schedulers/push.js';
import { DigestCrudService } from './service.js';
import {
  CHANNEL_SLOTS,
  type ChannelSlot,
  type DigestId,
  type GenerateResult,
  type Period,
  type WindowMode,
} from './types.js';

const intents: IntentDeclaration[] = [
  {
    name: 'digest_query',
    description: 'View today or yesterday digest',
    descriptions: { zh: '查看今日/昨日日报' },
    examples: ['来份日报', '查看昨天的日报', 'show me yesterday digest'],
    classificationHints: ['User wants to see a curated daily summary'],
    resultTypes: ['content'],
  },
  {
    name: 'digest_action',
    description: 'Manage digest subscriptions / presets / push schedule',
    descriptions: { zh: '管理日报订阅 / 预设 / 推送时间' },
    examples: ['订阅日报', '每天早上 8 点推送', '暂停日报'],
    classificationHints: ['User wants to change when or how digests are pushed'],
    resultTypes: ['action', 'clarify', 'content'],
  },
];

interface ConfigShape {
  enabled: boolean;
  dailyTime: string;
  maxItemsPerModule: number;
  linkSigningKey?: string;
  linkTtlDays: number;
  publicBaseUrl?: string;
}

let service: DigestCrudService | undefined;
let engine: DigestEngine | undefined;
let configState: ConfigShape | undefined;
// Module-level ref captured in initialize() so execute() can pass the DB to handlers
// without reaching into service's private `deps` (which would be a private-field cast).
let dbRef: DrizzleDB | undefined;
let callLlmFn: ServiceCallLlmFn | undefined;
// Live IANA timezone getter captured from `context.configStore` so `execute()`
// can pass the current tz into `handleDigestQuery` without reaching back into
// the configStore (which lives in `initialize`'s scope). Re-read on every
// call so a runtime commit of `GOLDPAN_TIMEZONE` hot-reloads.
let getTimezoneFn: (() => string) | undefined;
let scheduler: SchedulerHandle | undefined;
let pushScheduler: PushHandle | undefined;
// Backfill runs async from `postInit` so the server can start listening
// immediately (previously `await backfillMissing(...)` blocked `/health` on
// AI-summary LLM latency for every missing channel). `destroy()` awaits this
// promise so a shutdown mid-backfill still drains cleanly. Initialized to
// `Promise.resolve()` rather than `undefined` so a `destroy()` that races
// ahead of `postInit` — or any future refactor that inserts an `await`
// between the enabled-check and the assignment below — still awaits a
// no-op instead of a possibly-unset variable.
let backfillPromise: Promise<void> = Promise.resolve();

/**
 * A snapshot is considered fully empty when every module-level list and stat
 * count is zero. Used by the push scheduler to honor `preset.skipEmpty` —
 * empty days still advance `last_pushed_at` but skip outbound delivery.
 *
 * `modules` is typed as `Record<..., ModuleData>` so each lookup is the
 * discriminated union; narrow by the `type` tag before reading the
 * module-specific fields.
 */
function isFullyEmptyResult(result: GenerateResult): boolean {
  const m = result.snapshot.modules;
  const stats = m.stats;
  const trackingFindings = m.tracking_findings;
  const captures = m.captures;
  const thoughts = m.thoughts;
  const newEntities = m.new_entities;
  if (stats.type !== 'stats') return false;
  if (trackingFindings.type !== 'tracking_findings') return false;
  if (captures.type !== 'captures') return false;
  if (thoughts.type !== 'thoughts') return false;
  if (newEntities.type !== 'new_entities') return false;
  return (
    stats.captures === 0 &&
    stats.findings === 0 &&
    stats.thoughts === 0 &&
    stats.entities === 0 &&
    trackingFindings.items.length === 0 &&
    captures.items.length === 0 &&
    thoughts.items.length === 0 &&
    newEntities.items.length === 0
  );
}

// The IM runtime's `SessionRef` is shape-compatible with `IntentSessionRef`
// (both have channelId/accountId/chatId/userId). Reusing the core type here
// keeps the plugin from inventing a parallel shape — this service shape is
// the im-runtime wiring contract (see apps/server/src/im-compose.ts).
interface ImRuntimeService {
  sendOutbound: (
    channelId: string,
    ref: IntentSessionRef,
    result: IntentPluginResult,
  ) => Promise<void>;
  describeChannels: () => Array<{ channelId: string; state: string }>;
}

const TIME_HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'digest',
  group: 'digest',
  branding: {
    name: { en: 'Digest', zh: '日报' },
    tagline: { en: 'Scheduled summaries delivered to your IM', zh: '定时汇总推送到 IM' },
  },
  enable: {
    envKey: 'GOLDPAN_DIGEST_ENABLED',
    label: { en: 'Enable digest', zh: '启用日报' },
    default: false,
  },
  schema: z.object({
    dailyTime: z.string().regex(TIME_HH_MM, 'Expected HH:MM (24-hour)').optional(),
    maxItemsPerModule: z.number().int().positive().max(50).optional(),
  }),
  fields: [
    {
      name: 'dailyTime',
      kind: 'text',
      envKey: 'GOLDPAN_DIGEST_DAILY_TIME',
      label: { en: 'Daily delivery time', zh: '每日发送时间' },
      placeholder: { en: '09:00', zh: '09:00' },
      hint: {
        en: '24-hour HH:MM in the host timezone.',
        zh: 'host 时区,24 小时 HH:MM 格式。',
      },
      requiresRestart: false,
      // Keep in lockstep with the host config schema default
      // (packages/core/src/config/index.ts: GOLDPAN_DIGEST_DAILY_TIME
      // → .default('06:00')). Surfaced to the UI so the unconfigured row
      // displays the actual runtime value instead of "未配置".
      default: '06:00',
    },
    {
      name: 'maxItemsPerModule',
      kind: 'number',
      envKey: 'GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE',
      label: { en: 'Max items per module', zh: '每模块最多条目数' },
      hint: {
        en: 'Trim each module to this many items.',
        zh: '每个模块最多展示这么多条。',
      },
      min: 1,
      max: 50,
      step: 1,
      requiresRestart: false,
      // Mirrors core config default (.default(10)).
      default: 10,
    },
  ],
};

export const goldpanPlugin: IntentPlugin = {
  name: 'digest',
  version: '0.1.0',
  type: 'intent',
  description: 'Daily digest aggregator (captures / tracking / thoughts / stats)',
  descriptions: { zh: '每日摘要聚合（采集 / 跟踪 / 想法 / 统计）' },
  requiredCapabilities: ['db', 'pluginRegistry', 'config', 'callLlm'],
  settingsContribution,
  intents,

  async initialize(
    context: PluginContext,
    capabilities?: Partial<ServiceCapabilities>,
  ): Promise<void> {
    const db = capabilities?.db;
    const pluginRegistry = capabilities?.pluginRegistry;
    const config = (capabilities as { config?: { digest?: Partial<ConfigShape> } })?.config;
    const callLlm = capabilities?.callLlm;
    if (!db || !pluginRegistry) {
      throw new Error('digest plugin requires db, pluginRegistry capabilities');
    }
    // Hours 00–23, minutes 00–59. The naive `^\d{2}:\d{2}$` accepts impossible
    // values (24:99) that `Date#setUTCHours` silently normalizes to a different
    // UTC day, so schedulers would fire at the wrong moment.
    const envSchema = z.object({
      enabled: z.boolean().default(false),
      dailyTime: z.string().regex(TIME_HH_MM).default('06:00'),
      maxItemsPerModule: z.number().int().positive().default(10),
      linkSigningKey: z.string().min(32).optional(),
      linkTtlDays: z.number().int().min(1).max(365).default(14),
      publicBaseUrl: z.string().url().optional(),
    });
    configState = envSchema.parse({
      enabled: config?.digest?.enabled ?? false,
      dailyTime: config?.digest?.dailyTime ?? '06:00',
      maxItemsPerModule: config?.digest?.maxItemsPerModule ?? 10,
      linkSigningKey: config?.digest?.linkSigningKey ?? undefined,
      linkTtlDays: config?.digest?.linkTtlDays ?? 14,
      publicBaseUrl: config?.digest?.publicBaseUrl ?? undefined,
    });

    // Validate prompt files exist (even if disabled, keeps deploy honest).
    validatePrompts();

    if (!configState.enabled) {
      // Disabled mode: do not create tables or service. Intent is still declared
      // above so the classifier sees it; execute() returns plugin_disabled content.
      return;
    }

    if (!callLlm) {
      throw new Error('digest plugin requires callLlm capability when enabled');
    }

    ensureDigestTables(db);
    resetCrashedDigestState(db);
    // Hot-reloadable config — read fresh from configStore at each digest
    // generation so a runtime commit of GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE
    // (and now `GOLDPAN_TIMEZONE` via the service's `yesterdayLocalISO`)
    // takes effect on the next call without restart. `configState` above is
    // still parsed for boot-time zod validation (catches malformed env values
    // before the scheduler touches them) but its captured `maxItemsPerModule`
    // is intentionally no longer threaded through — the configStore snapshot
    // is the single source of truth at runtime. Capture once at the top of
    // `initialize` so the service, engine getter, and the daily-scheduler
    // getter below all use the same closure name.
    const configStoreRef = context.configStore;
    service = new DigestCrudService({
      db,
      getTimezone: () => configStoreRef.getSnapshot().config.timezone,
    });
    service.seedDefaultPresets('web');
    service.seedDefaultPresets('telegram');
    const capturedServiceForEngine = service;
    engine = new DigestEngine({
      db,
      getMaxItemsPerModule: () => configStoreRef.getSnapshot().config.digest.maxItemsPerModule,
      callLlm,
      logger: context.logger,
      getSnapshot: async (id: DigestId) => {
        // Preset-level snapshots honor preset.period (weekly preset spans
        // the 7 days ending at id.date) AND preset.windowMode (rolling vs
        // calendar). Channel-level snapshots (preset_id IS NULL from
        // backfill / daily cron) stay calendar+daily by design — they're
        // the deterministic "yesterday" slice, not user-configurable.
        let period: Period = 'daily';
        let windowMode: WindowMode = 'calendar';
        if (id.presetId !== null) {
          const preset = capturedServiceForEngine.getPreset(id.presetId);
          if (preset?.period === 'weekly') period = 'weekly';
          if (preset?.windowMode === 'rolling') windowMode = 'rolling';
        }
        // `id.date` is the user-local YMD produced by `yesterdayLocalISO(now,
        // tz)`. Calendar mode uses it to compute user-local-midnight edges in
        // tz; rolling mode ignores date/tz and slides off `anchorMs=Date.now()`
        // so a 23:30 manual regenerate covers "the past 24h up to 23:30",
        // while the 06:00 cron the same day covers "the past 24h up to 06:00"
        // — calendar mode would have produced the same window in both cases.
        const tz = configStoreRef.getSnapshot().config.timezone;
        const range = computeDigestRange(id.date, period, tz, { windowMode }) as DateRange;
        return { digestId: id, period, range, cacheable: windowMode !== 'rolling' };
      },
    });
    dbRef = db;
    callLlmFn = callLlm;
    getTimezoneFn = () => configStoreRef.getSnapshot().config.timezone;
    pluginRegistry.registerService('digest', service);
  },

  async postInit(
    context: PluginContext,
    capabilities?: Partial<ServiceCapabilities>,
  ): Promise<void> {
    if (!configState?.enabled || !service || !engine) return;
    const capturedService = service;
    const capturedEngine = engine;

    // First-run seed from the one-click setup wizard. The wizard's
    // `applyMetadata()` writes `digest_initial_preset` (shape:
    // `{modules: string[], maxItems: number}`) before the server boots; we
    // consume it here on the first postInit after wizard completion and
    // delete the key so re-runs are no-ops.
    //
    // Why not gate on `listPresets('web').length === 0`?
    //   `initialize()` above already calls `service.seedDefaultPresets('web')`,
    //   so the channel is never empty by the time postInit runs. The
    //   metadata key itself is the one-shot signal — gate only on its
    //   presence, and ALWAYS delete it after the first attempt (success,
    //   parse error, or unique-name collision) to prevent every restart
    //   re-running the seed.
    //
    // We construct our own SqliteMetadataRepository over capabilities.db
    // rather than expanding ServiceCapabilities — keeps cross-plugin
    // metadata reads opt-in.
    try {
      const seedDb = capabilities?.db;
      if (seedDb) {
        const { SqliteMetadataRepository } = await import('@goldpan/core/db/repositories');
        const seedMetadataRepo = new SqliteMetadataRepository(seedDb);
        const seedRaw = seedMetadataRepo.get('digest_initial_preset');
        if (seedRaw) {
          try {
            const seed = JSON.parse(seedRaw) as { modules?: unknown; maxItems?: unknown };
            if (!Array.isArray(seed.modules) || typeof seed.maxItems !== 'number') {
              throw new Error('invalid digest_initial_preset shape');
            }
            // Whitelist filter: silently drop any unknown slot string that
            // sneaks into the metadata (defends against schema drift between
            // wizard versions).
            const validSlots = new Set<ChannelSlot>(CHANNEL_SLOTS);
            const modules = seed.modules.filter(
              (m): m is ChannelSlot => typeof m === 'string' && validSlots.has(m as ChannelSlot),
            );
            try {
              capturedService.createPreset('web', {
                name: 'wizard_default',
                period: 'daily',
                pushDay: null,
                pushTime: '08:00',
                windowMode: 'calendar',
                slots: modules,
                skipEmpty: true,
                includeAiSummary: modules.includes('ai_summary'),
                isDefault: true,
              });
            } catch (createErr) {
              // Likely a unique(channel, name) collision from a re-run before
              // the first run consumed the key. Log + still consume so we
              // don't retry every boot.
              context.logger.warn(
                'digest postInit seed: createPreset failed (likely duplicate); consuming metadata key anyway',
                {
                  err: errorMessage(createErr),
                },
              );
            }
          } finally {
            // Always consume — even on parse error / unique collision —
            // because the alternative (leaving the key in place) means
            // logging a warning on every server boot.
            seedMetadataRepo.delete('digest_initial_preset');
          }
        }
      }
    } catch (e) {
      // Top-level guard: never let seed failure block the rest of postInit
      // (regenerator wiring, scheduler start, etc).
      context.logger.error('digest postInit seed: unexpected error', {
        err: errorMessage(e),
      });
    }

    // Close over the service so scheduler saveReport callbacks forward every
    // generated snapshot into `daily_reports`. Previously schedulers called
    // `engine.generate` and threw the result away — `daily_reports` was only
    // written by the `/digest` intent path (P0-1).
    // `saveGeneratedResult` returns `false` for partial snapshots — those
    // never enter `daily_reports`. Push scheduler already throws + logs on
    // partial before calling this, so it only matters for backfill and the
    // daily cron: without the warn below, a partial result there would
    // silently drop the row and the operator would see "/digest empty" with
    // no clue in the logs. Channel/date/presetId are pulled off the snapshot
    // (not the `_channel` arg) because `saveGeneratedResult` does the same.
    const persistSnapshot = (_channel: string, result: GenerateResult): void => {
      if (capturedService.saveGeneratedResult(result)) return;
      context.logger.warn('digest: dropping partial snapshot (not persisted)', {
        channel: result.snapshot.digestId.channel,
        date: result.snapshot.digestId.date,
        presetId: result.snapshot.digestId.presetId,
        status: result.status,
      });
    };
    // Wire the engine-backed regenerate helper so `/digest/preview?
    // forceRegenerate=true` (and the UI Regenerate button) can re-collect
    // modules + LLM summary and overwrite `daily_reports`. Attached here in
    // postInit because the service is registered before the engine exists.
    capturedService.attachRegenerator((channel, date, presetId, opts) =>
      capturedEngine.generate(
        { channel, date, presetId },
        { includeAiSummary: opts.includeAiSummary, forceRegenerate: true },
      ),
    );
    // One-shot backfill for any channel missing yesterday's snapshot. Run
    // *asynchronously* — awaiting here blocked the HTTP listener behind
    // LLM-paced digest generation on cold boots (one missing channel per
    // seeded deployment, plus the AI-summary LLM call, is easily tens of
    // seconds), so `/health` and every other route stayed 503 during that
    // window. `backfillMissing` already isolates per-channel errors and
    // logs them; the top-level catch here only guards against an unhandled
    // rejection if the function itself throws before reaching that loop.
    // `destroy()` awaits the stored promise so a shutdown mid-backfill
    // still drains cleanly.
    //
    // `configStoreRef` is captured here in postInit (separate scope from
    // initialize); the engine getter captured its own copy at construction
    // time, both pointing at the same `context.configStore` instance.
    // Hoisted above the backfill call so the live `config.timezone` snapshot
    // can resolve into `yesterdayLocalISO` below.
    const configStoreRef = context.configStore;
    backfillPromise = backfillMissing({
      generate: (id, opts) => capturedEngine.generate(id, opts),
      getMissing: (date) => capturedService.listChannelsMissingReport(date),
      date: yesterdayLocalISO(new Date(), configStoreRef.getSnapshot().config.timezone),
      saveReport: persistSnapshot,
      logger: context.logger,
    }).catch((err) => {
      context.logger.warn('digest postInit backfill failed (top-level)', {
        error: errorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    });
    // Start the daily scheduler. `getDailyTimeHHMM` reads the configStore
    // snapshot every tick so a runtime commit of GOLDPAN_DIGEST_DAILY_TIME
    // takes effect on the next minute-aligned tick — no restart, no
    // onChange wiring (poll-based architecture handles hot-reload by
    // construction; see SchedulerDeps JSDoc).
    scheduler = createDataSnapshotScheduler({
      getDailyTimeHHMM: () => configStoreRef.getSnapshot().config.digest.dailyTime,
      getTimezone: () => configStoreRef.getSnapshot().config.timezone,
      generate: (id, opts) => capturedEngine.generate(id, opts),
      getChannels: () => capturedService.listChannels(),
      saveReport: persistSnapshot,
      logger: context.logger,
    });
    scheduler.start();

    // Wire the per-subscription push scheduler if the IM runtime is composed
    // in. The lookup is structural so `@goldpan/plugin-digest` stays free of a
    // reverse dependency on `@goldpan/im-runtime` (CLAUDE.md §1).
    const imRuntime = capabilities?.pluginRegistry?.getService<ImRuntimeService>('im_runtime');
    if (imRuntime) {
      // Read the deployment's language from core config so scheduled IM
      // pushes render in the configured language instead of the default
      // `'en'`. The config key only accepts `'en' | 'zh'` at the schema
      // level, so we don't need a fallback for other values — but guard
      // against it being absent just in case a test harness omits the
      // capability. Per-channel overrides can be added later if the
      // deployment ever wants Telegram in a different language than the
      // REST API.
      const configLanguage =
        (capabilities as { config?: { language?: 'en' | 'zh' } })?.config?.language ?? 'en';

      const linkSigningKey = configState.linkSigningKey ?? null;
      const linkTtlDays = configState.linkTtlDays ?? 14;
      const publicBaseUrl = configState.publicBaseUrl ?? null;

      // share-link footer 是可选增强:缺任一配置 → 跳过 footer,IM body 仍正常发出。
      if (!linkSigningKey || !publicBaseUrl) {
        context.logger.warn(
          'digest push scheduler: share-link footer disabled — set both GOLDPAN_DIGEST_LINK_SIGNING_KEY (≥32 chars) and GOLDPAN_DIGEST_PUBLIC_BASE_URL to enable signed share URLs in IM push body. Push delivery itself continues to work.',
          {
            hasSigningKey: !!linkSigningKey,
            hasPublicBaseUrl: !!publicBaseUrl,
          },
        );
      }

      pushScheduler = createPushScheduler({
        listDueSubscriptions: () => capturedService.listAllActiveSubscriptions(),
        getPreset: (id) => capturedService.getPreset(id),
        generate: (id, preset) =>
          capturedEngine.generate(id, { includeAiSummary: preset.includeAiSummary }),
        isFullyEmpty: isFullyEmptyResult,
        renderIM: (result, preset, language) =>
          renderIMDigest(result.snapshot, {
            language,
            slots: preset.slots,
            skipEmpty: preset.skipEmpty,
            tz: configStoreRef.getSnapshot().config.timezone,
          }),
        sendOutbound: (channelId, ref, result) =>
          imRuntime.sendOutbound(
            channelId,
            {
              channelId: ref.channelId,
              accountId: ref.accountId,
              chatId: ref.chatId,
              userId: ref.userId,
            },
            result,
          ),
        markPushed: (id, at) => capturedService.markPushed(id, at),
        saveReport: persistSnapshot,
        // Same `configStoreRef` snapshot getter as the data-snapshot
        // scheduler — runtime commits to `GOLDPAN_TIMEZONE` propagate to
        // push at the next tick without restart.
        getTimezone: () => configStoreRef.getSnapshot().config.timezone,
        channelLanguage: () => configLanguage,
        canSendChannel: (channelId) =>
          imRuntime
            .describeChannels()
            .some(
              (descriptor: { channelId: string; state: string }) =>
                descriptor.channelId === channelId && descriptor.state === 'running',
            ),
        logger: context.logger,
        // signingKey / publicBaseUrl 可能为 null:scheduler 内部分支处理。
        getReportRowId: (channel, date, presetId) =>
          capturedService.getReportRowId(channel, date, presetId),
        ...(linkSigningKey ? { signingKey: linkSigningKey } : {}),
        ttlDays: linkTtlDays,
        ...(publicBaseUrl ? { publicBaseUrl } : {}),
      });
      pushScheduler.start();
    }
  },

  async destroy(): Promise<void> {
    // Wait for the async backfill started in postInit to finish so a
    // shutdown mid-backfill doesn't leave a half-written `daily_reports`
    // row (`saveReport` is a single statement, but the surrounding LLM
    // call is what takes time). The stored promise is pre-`.catch`'d so
    // awaiting cannot throw here; reset to `Promise.resolve()` afterward
    // so a second `destroy()` (or a re-initialize flow in tests) still
    // sees a valid no-op promise.
    await backfillPromise;
    backfillPromise = Promise.resolve();
    await scheduler?.drain();
    scheduler = undefined;
    await pushScheduler?.drain();
    pushScheduler = undefined;
    service = undefined;
    engine = undefined;
    configState = undefined;
    dbRef = undefined;
    callLlmFn = undefined;
    getTimezoneFn = undefined;
  },

  async execute(
    intent: string,
    _input: string,
    _ctx: IntentExecutionContext,
  ): Promise<IntentPluginResult> {
    const language = (_ctx?.language ?? 'en') as 'en' | 'zh';
    if (!configState?.enabled) return disabledContent(language);
    if (!service || !engine || !dbRef || !getTimezoneFn) {
      throw new Error('digest plugin not initialized');
    }
    // Prefer the conversation channel when available (IM flow); fall back to
    // 'web' for REST/CLI callers that have no conversation attached.
    const channel = _ctx?.conversation?.channelId ?? 'web';
    switch (intent) {
      case 'digest_query':
        return handleDigestQuery({
          db: dbRef,
          service,
          engine,
          channel,
          language,
          tz: getTimezoneFn(),
        });
      case 'digest_action': {
        if (!service) throw new Error('digest service not ready');
        if (!callLlmFn) throw new Error('callLlm not available');
        // Prefer the explicit `sessionRef` supplied by the IM runtime's inbound
        // dispatcher — it always carries the real `userId` even under
        // `per_chat` routing (where `sessionKey` drops it). Fall back to
        // parsing `sessionKey` only for the per_user 4-segment form, which
        // uniquely identifies a user. The parser refuses 3-segment per_chat
        // keys (would otherwise invent `userId = chatId` and collide every
        // group-chat user onto the same subscription row — see P1-2).
        let ref: IntentSessionRef | null = _ctx.sessionRef ?? null;
        if (!ref) {
          if (!_ctx.conversation) {
            return {
              type: 'content',
              text:
                language === 'zh'
                  ? '订阅管理只能在 IM 会话里使用，请在 Telegram 里发送该指令。'
                  : 'Subscription management is only available inside IM chats — try this command in Telegram.',
            };
          }
          ref = parseSessionKey(_ctx.conversation.sessionKey);
          if (!ref) {
            // Either malformed or the 3-segment per_chat form where userId
            // is not recoverable from the key alone. Production callers go
            // through the IM dispatcher which always supplies `sessionRef`;
            // any code path reaching this point is missing that wiring.
            throw new Error(
              `digest_action: cannot resolve userId from sessionKey "${_ctx.conversation.sessionKey}" — IM runtime must populate IntentExecutionContext.sessionRef`,
            );
          }
        }
        const presets = service.listPresets(ref.channelId).map(({ id, name }) => ({ id, name }));
        const action = await parseDigestAction({
          input: _input,
          language,
          presets,
          callLlm: callLlmFn,
        });
        if (!action) {
          return {
            type: 'clarify',
            question:
              language === 'zh'
                ? '不太明白你想怎么改订阅，例如："订阅 daily_default 8:30"。'
                : 'Could you rephrase? e.g. "subscribe daily_default 8:30".',
          };
        }
        return handleDigestAction({ action, language, service, ref });
      }
      default:
        throw new Error(`Unknown digest intent: ${intent}`);
    }
  },
};
