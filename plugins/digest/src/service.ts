import { type DrizzleDB, getRawDatabase } from '@goldpan/core/db';
import type { Language } from '@goldpan/core/i18n';
import { DigestGenerateError } from './errors.js';
import { DEFAULT_PRESETS } from './preset-defaults.js';
import { yesterdayLocalISO } from './render/helpers.js';
import { renderDigestMarkdown } from './render/markdown.js';
import type {
  ChannelSlot,
  DataSnapshot,
  DigestPresetRow,
  DigestSubscriptionRow,
  GenerateResult,
  Period,
  WindowMode,
} from './types.js';

export interface DigestCrudServiceOptions {
  db: DrizzleDB;
  /**
   * Live IANA timezone source — used by {@link DigestCrudService.yesterdayLocalISO}
   * to compute the "yesterday" date that all touch-points (intent / backfill /
   * schedulers / `/digest/preview`) must agree on. A getter (not a captured
   * string) so a runtime `commit()` of `GOLDPAN_TIMEZONE` hot-reloads without
   * restart, mirroring the pattern used for `getMaxItemsPerModule` /
   * `getDailyTimeHHMM` elsewhere in the plugin.
   */
  getTimezone: () => string;
}

/**
 * Callback that re-runs the digest engine and returns a fresh snapshot.
 * Attached via {@link DigestCrudService.attachRegenerator} in `postInit`
 * because the engine is constructed after the service (so the service can
 * be registered with the plugin registry before schedulers spin up).
 *
 * The service computes `includeAiSummary` from the target preset (or the
 * channel's default preset when `presetId` is null) and always forces the
 * engine to bypass its cache for explicit regenerate requests.
 */
export type RegenerateFn = (
  channel: string,
  date: string,
  presetId: number | null,
  opts: { includeAiSummary: boolean },
) => Promise<GenerateResult>;

export interface CreatePresetInput {
  name: string;
  period: Period;
  pushDay: number | null;
  pushTime: string;
  windowMode: WindowMode;
  slots: ChannelSlot[];
  skipEmpty: boolean;
  includeAiSummary: boolean;
  isDefault: boolean;
}

export type UpdatePresetInput = Partial<CreatePresetInput>;

export interface UpsertSubscriptionInput {
  channelId: string;
  accountId: string;
  chatId: string;
  userId: string;
  presetId: number;
  pushTime: string;
  paused?: boolean;
}

export interface UpdateSubscriptionInput {
  presetId?: number;
  pushTime?: string;
  paused?: boolean;
}

export interface PresetUsage {
  subscriptionId: number;
  channelId: string;
  chatId: string;
  userId: string;
}

interface PresetDbRow {
  id: number;
  channel: string;
  name: string;
  period: string;
  push_day: number | null;
  push_time: string;
  window_mode: string;
  slots_json: string;
  skip_empty: number;
  include_ai_summary: number;
  is_default: number;
}

interface SubscriptionDbRow {
  id: number;
  channel_id: string;
  account_id: string;
  chat_id: string;
  user_id: string;
  preset_id: number;
  push_time: string;
  paused: number;
  last_pushed_at: number | null;
}

function mapPreset(row: PresetDbRow): DigestPresetRow {
  return {
    id: row.id,
    channel: row.channel,
    name: row.name,
    period: row.period as Period,
    pushDay: row.push_day,
    pushTime: row.push_time,
    windowMode: row.window_mode as WindowMode,
    slots: JSON.parse(row.slots_json) as ChannelSlot[],
    skipEmpty: row.skip_empty === 1,
    includeAiSummary: row.include_ai_summary === 1,
    isDefault: row.is_default === 1,
  };
}

function mapSubscription(row: SubscriptionDbRow): DigestSubscriptionRow {
  return {
    id: row.id,
    channelId: row.channel_id,
    accountId: row.account_id,
    chatId: row.chat_id,
    userId: row.user_id,
    presetId: row.preset_id,
    pushTime: row.push_time,
    paused: row.paused === 1,
    lastPushedAt: row.last_pushed_at,
  };
}

export class DigestCrudService {
  private readonly db: DrizzleDB;
  private readonly getTimezone: () => string;
  private regenerator: RegenerateFn | null = null;
  /**
   * Single-flight map keyed by `channel|date|presetId`. Two concurrent
   * "Regenerate" clicks for the same digest key share one underlying
   * `regenerator(...)` call — without this, `engine.generate({
   * forceRegenerate: true })` skips its own in-flight dedupe, so both
   * requests re-collect modules, both pay the AI-summary LLM cost, and
   * their concurrent UPSERTs stomp each other. Scoped to this service
   * (not the engine) because the lock must cover the whole "regenerate
   * + saveReport" sequence — otherwise the second caller can read the
   * mid-write row and race with the UPSERT.
   */
  private readonly regenerateInFlight = new Map<string, Promise<DataSnapshot>>();

  constructor(options: DigestCrudServiceOptions) {
    this.db = options.db;
    this.getTimezone = options.getTimezone;
  }

  /**
   * Wire the engine-backed regenerate path (invoked by the "Regenerate"
   * button on `/digest`). Called once from `postInit` after the engine is
   * constructed. Without this, {@link regenerateAndSave} throws — routes
   * that reach for it at request time must surface a 503.
   */
  attachRegenerator(fn: RegenerateFn): void {
    this.regenerator = fn;
  }

  seedDefaultPresets(channel: string): void {
    const raw = getRawDatabase(this.db);
    const now = Date.now();
    raw
      .transaction(() => {
        const insert = raw.prepare(
          `INSERT INTO digest_presets (channel, name, period, push_day, push_time, window_mode, slots_json, skip_empty, include_ai_summary, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel, name) DO NOTHING`,
        );
        for (const preset of DEFAULT_PRESETS) {
          insert.run(
            channel,
            preset.name,
            preset.period,
            preset.pushDay,
            preset.pushTime,
            preset.windowMode,
            JSON.stringify(preset.slots),
            preset.skipEmpty ? 1 : 0,
            preset.includeAiSummary ? 1 : 0,
            preset.isDefault ? 1 : 0,
            now,
            now,
          );
        }
      })
      .immediate();
  }

  listPresets(channel: string): DigestPresetRow[] {
    const raw = getRawDatabase(this.db);
    const rows = raw
      .prepare(
        `SELECT id, channel, name, period, push_day, push_time, window_mode, slots_json, skip_empty, include_ai_summary, is_default
         FROM digest_presets WHERE channel = ? ORDER BY id ASC`,
      )
      .all(channel) as PresetDbRow[];
    return rows.map(mapPreset);
  }

  getPreset(id: number): DigestPresetRow | null {
    const raw = getRawDatabase(this.db);
    const row = raw
      .prepare(
        `SELECT id, channel, name, period, push_day, push_time, window_mode, slots_json, skip_empty, include_ai_summary, is_default
         FROM digest_presets WHERE id = ?`,
      )
      .get(id) as PresetDbRow | undefined;
    return row ? mapPreset(row) : null;
  }

  private getDefaultPreset(channel: string): DigestPresetRow | null {
    const presets = this.listPresets(channel);
    return presets.find((p) => p.isDefault) ?? presets[0] ?? null;
  }

  private getPresetForChannel(channel: string, presetId: number): DigestPresetRow | null {
    const preset = this.getPreset(presetId);
    if (!preset) return null;
    return preset.channel === channel ? preset : null;
  }

  createPreset(channel: string, input: CreatePresetInput): DigestPresetRow {
    const raw = getRawDatabase(this.db);
    let createdId: number | null = null;
    raw
      .transaction(() => {
        const now = Date.now();
        // Channels seeded by `seedDefaultPresets` always have exactly one
        // row with `is_default = 1`, so inserting a second default would
        // violate `ux_digest_presets_default_per_channel` and surface as a
        // generic 500 on the create form. Mirror `updatePreset`'s
        // "clear sibling defaults first" path so `isDefault: true` is a
        // legitimate creation option end-to-end.
        if (input.isDefault) {
          raw
            .prepare(
              `UPDATE digest_presets SET is_default = 0, updated_at = ?
               WHERE channel = ? AND is_default = 1`,
            )
            .run(now, channel);
        }
        const result = raw
          .prepare(
            `INSERT INTO digest_presets (channel, name, period, push_day, push_time, window_mode, slots_json, skip_empty, include_ai_summary, is_default, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            channel,
            input.name,
            input.period,
            input.pushDay,
            input.pushTime,
            input.windowMode,
            JSON.stringify(input.slots),
            input.skipEmpty ? 1 : 0,
            input.includeAiSummary ? 1 : 0,
            input.isDefault ? 1 : 0,
            now,
            now,
          );
        createdId = Number(result.lastInsertRowid);
      })
      .immediate();
    if (createdId === null) {
      throw new DigestGenerateError('preset_not_found', 'Failed to create preset');
    }
    const created = this.getPreset(createdId);
    if (!created) {
      throw new DigestGenerateError('preset_not_found', 'Failed to read back created preset');
    }
    return created;
  }

  updatePreset(id: number, input: UpdatePresetInput): DigestPresetRow {
    const existing = this.getPreset(id);
    if (!existing) {
      throw new DigestGenerateError('preset_not_found', `Preset ${id} not found`);
    }
    const merged: DigestPresetRow = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.period !== undefined && { period: input.period }),
      ...(input.pushDay !== undefined && { pushDay: input.pushDay }),
      ...(input.pushTime !== undefined && { pushTime: input.pushTime }),
      ...(input.windowMode !== undefined && { windowMode: input.windowMode }),
      ...(input.slots !== undefined && { slots: input.slots }),
      ...(input.skipEmpty !== undefined && { skipEmpty: input.skipEmpty }),
      ...(input.includeAiSummary !== undefined && { includeAiSummary: input.includeAiSummary }),
      ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
    };
    const raw = getRawDatabase(this.db);
    raw
      .transaction(() => {
        // Clear sibling defaults first so the partial unique index
        // `ux_digest_presets_default_per_channel` does not conflict.
        if (input.isDefault === true) {
          raw
            .prepare(
              `UPDATE digest_presets SET is_default = 0, updated_at = ?
               WHERE channel = ? AND id <> ? AND is_default = 1`,
            )
            .run(Date.now(), existing.channel, id);
        }
        raw
          .prepare(
            `UPDATE digest_presets
             SET name = ?, period = ?, push_day = ?, push_time = ?, window_mode = ?, slots_json = ?, skip_empty = ?, include_ai_summary = ?, is_default = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            merged.name,
            merged.period,
            merged.pushDay,
            merged.pushTime,
            merged.windowMode,
            JSON.stringify(merged.slots),
            merged.skipEmpty ? 1 : 0,
            merged.includeAiSummary ? 1 : 0,
            merged.isDefault ? 1 : 0,
            Date.now(),
            id,
          );
      })
      .immediate();
    const after = this.getPreset(id);
    if (!after) {
      throw new DigestGenerateError('preset_not_found', `Preset ${id} not found after update`);
    }
    return after;
  }

  deletePreset(id: number): void {
    const raw = getRawDatabase(this.db);
    const usages = raw
      .prepare(
        `SELECT id AS subscriptionId, channel_id AS channelId, chat_id AS chatId, user_id AS userId
         FROM digest_subscriptions WHERE preset_id = ?`,
      )
      .all(id) as PresetUsage[];
    if (usages.length > 0) {
      const err = new DigestGenerateError(
        'preset_in_use',
        `Preset ${id} is used by ${usages.length} subscription(s)`,
      );
      (err as DigestGenerateError & { usages: PresetUsage[] }).usages = usages;
      throw err;
    }
    raw.prepare('DELETE FROM digest_presets WHERE id = ?').run(id);
  }

  listSubscriptions(filter?: {
    channelId?: string;
    accountId?: string;
    chatId?: string;
    userId?: string;
  }): DigestSubscriptionRow[] {
    const raw = getRawDatabase(this.db);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.channelId !== undefined) {
      clauses.push('channel_id = ?');
      params.push(filter.channelId);
    }
    if (filter?.accountId !== undefined) {
      clauses.push('account_id = ?');
      params.push(filter.accountId);
    }
    if (filter?.chatId !== undefined) {
      clauses.push('chat_id = ?');
      params.push(filter.chatId);
    }
    if (filter?.userId !== undefined) {
      clauses.push('user_id = ?');
      params.push(filter.userId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = raw
      .prepare(
        `SELECT id, channel_id, account_id, chat_id, user_id, preset_id, push_time, paused, last_pushed_at
         FROM digest_subscriptions ${where} ORDER BY id ASC`,
      )
      .all(...params) as SubscriptionDbRow[];
    return rows.map(mapSubscription);
  }

  getSubscription(id: number): DigestSubscriptionRow | null {
    const raw = getRawDatabase(this.db);
    const row = raw
      .prepare(
        `SELECT id, channel_id, account_id, chat_id, user_id, preset_id, push_time, paused, last_pushed_at
         FROM digest_subscriptions WHERE id = ?`,
      )
      .get(id) as SubscriptionDbRow | undefined;
    return row ? mapSubscription(row) : null;
  }

  upsertSubscription(input: UpsertSubscriptionInput): DigestSubscriptionRow {
    const preset = this.getPresetForChannel(input.channelId, input.presetId);
    if (!preset) {
      throw new DigestGenerateError(
        'preset_channel_mismatch',
        `Preset ${input.presetId} does not belong to channel ${input.channelId}`,
      );
    }
    const raw = getRawDatabase(this.db);
    const now = Date.now();
    // On re-subscribe, also reset `paused` to the caller's requested state
    // (defaults to `0`). Previously the conflict arm left `paused` untouched,
    // so a user who had paused their subscription and then said "subscribe"
    // again got a success reply while `listAllActiveSubscriptions` kept
    // filtering them out — the push scheduler would never deliver. `paused`
    // maps via `excluded.paused` so the subscribe + explicit-pause paths
    // share one DB statement.
    raw
      .prepare(
        `INSERT INTO digest_subscriptions (channel_id, account_id, chat_id, user_id, preset_id, push_time, paused, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, account_id, chat_id, user_id, preset_id) DO UPDATE SET
           push_time = excluded.push_time,
           paused = excluded.paused,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.channelId,
        input.accountId,
        input.chatId,
        input.userId,
        input.presetId,
        input.pushTime,
        input.paused === true ? 1 : 0,
        now,
        now,
      );
    const row = raw
      .prepare(
        `SELECT id, channel_id, account_id, chat_id, user_id, preset_id, push_time, paused, last_pushed_at
         FROM digest_subscriptions
         WHERE channel_id = ? AND account_id = ? AND chat_id = ? AND user_id = ? AND preset_id = ?`,
      )
      .get(input.channelId, input.accountId, input.chatId, input.userId, input.presetId) as
      | SubscriptionDbRow
      | undefined;
    if (!row) {
      throw new DigestGenerateError(
        'subscription_not_found',
        'Failed to read back upserted subscription',
      );
    }
    return mapSubscription(row);
  }

  updateSubscription(id: number, input: UpdateSubscriptionInput): DigestSubscriptionRow {
    const existing = this.getSubscription(id);
    if (!existing) {
      throw new DigestGenerateError('subscription_not_found', `Subscription ${id} not found`);
    }
    if (
      input.presetId !== undefined &&
      !this.getPresetForChannel(existing.channelId, input.presetId)
    ) {
      throw new DigestGenerateError(
        'preset_channel_mismatch',
        `Preset ${input.presetId} does not belong to channel ${existing.channelId}`,
      );
    }
    const merged: DigestSubscriptionRow = {
      ...existing,
      ...(input.presetId !== undefined && { presetId: input.presetId }),
      ...(input.pushTime !== undefined && { pushTime: input.pushTime }),
      ...(input.paused !== undefined && { paused: input.paused }),
    };
    const raw = getRawDatabase(this.db);
    raw
      .prepare(
        `UPDATE digest_subscriptions
         SET preset_id = ?, push_time = ?, paused = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(merged.presetId, merged.pushTime, merged.paused ? 1 : 0, Date.now(), id);
    const after = this.getSubscription(id);
    if (!after) {
      throw new DigestGenerateError(
        'subscription_not_found',
        `Subscription ${id} not found after update`,
      );
    }
    return after;
  }

  deleteSubscription(id: number): void {
    const raw = getRawDatabase(this.db);
    raw.prepare('DELETE FROM digest_subscriptions WHERE id = ?').run(id);
  }

  /**
   * Run a callback inside a single SQLite transaction so callers can batch
   * sequences of mutating service calls (e.g. bulk pause / resume / delete
   * of subscriptions from an IM action) into one fsync instead of N.
   */
  runInTransaction<T>(fn: () => T): T {
    const raw = getRawDatabase(this.db);
    return raw.transaction(fn)();
  }

  markPushed(id: number, at: number): void {
    const raw = getRawDatabase(this.db);
    raw
      .prepare('UPDATE digest_subscriptions SET last_pushed_at = ?, updated_at = ? WHERE id = ?')
      .run(at, Date.now(), id);
  }

  /** Every non-paused subscription, regardless of channel or user — used by the push scheduler. */
  listAllActiveSubscriptions(): DigestSubscriptionRow[] {
    const raw = getRawDatabase(this.db);
    const rows = raw
      .prepare(
        `SELECT id, channel_id, account_id, chat_id, user_id, preset_id, push_time, paused, last_pushed_at
         FROM digest_subscriptions WHERE paused = 0 ORDER BY id ASC`,
      )
      .all() as SubscriptionDbRow[];
    return rows.map(mapSubscription);
  }

  /** List every channel that has at least one preset configured. */
  listChannels(): string[] {
    const raw = getRawDatabase(this.db);
    const rows = raw.prepare('SELECT DISTINCT channel FROM digest_presets').all() as Array<{
      channel: string;
    }>;
    return rows.map((r) => r.channel);
  }

  /** Channels that have presets but no `daily_reports` row for `date` yet. */
  listChannelsMissingReport(date: string): string[] {
    const all = this.listChannels();
    const raw = getRawDatabase(this.db);
    const presentRows = raw
      .prepare(
        `SELECT DISTINCT channel
         FROM daily_reports
         WHERE report_date = ? AND preset_id IS NULL`,
      )
      .all(date) as Array<{ channel: string }>;
    const present = new Set(presentRows.map((r) => r.channel));
    return all.filter((c) => !present.has(c));
  }

  /**
   * Force a fresh snapshot via the engine and persist it to `daily_reports`.
   * Used by the `/digest/preview?forceRegenerate=true` route and the
   * "Regenerate" button on the web UI. The regenerator must already be
   * attached (see {@link attachRegenerator}); callers that encounter the
   * `regenerator_not_attached` error should surface a 503 — it means the
   * digest plugin is enabled but `postInit` has not finished wiring yet.
   */
  async regenerateAndSave(
    channel: string,
    date: string,
    presetId: number | null,
  ): Promise<DataSnapshot> {
    if (!this.regenerator) {
      throw new DigestGenerateError(
        'regenerator_not_attached',
        'Digest regenerate helper is not wired — postInit has not completed',
      );
    }
    const key = `${channel}|${date}|${presetId ?? 'null'}`;
    const existing = this.regenerateInFlight.get(key);
    if (existing) return existing;
    const regenerator = this.regenerator;
    const promise = (async () => {
      const preset =
        presetId === null
          ? this.getDefaultPreset(channel)
          : this.getPresetForChannel(channel, presetId);
      if (presetId !== null && !preset) {
        throw new DigestGenerateError(
          'preset_channel_mismatch',
          `Preset ${presetId} does not belong to channel ${channel}`,
        );
      }
      const result = await regenerator(channel, date, presetId, {
        includeAiSummary: preset?.includeAiSummary ?? true,
      });
      this.saveGeneratedResult(result);
      return result.snapshot;
    })();
    this.regenerateInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      // Guard against concurrent `set` for the same key: only delete the
      // entry that *this* invocation registered, so a later call that
      // started a new regenerate doesn't get its promise evicted.
      if (this.regenerateInFlight.get(key) === promise) {
        this.regenerateInFlight.delete(key);
      }
    }
  }

  saveReport(input: {
    channel: string;
    reportDate: string;
    period: Period;
    presetId: number | null;
    snapshot: DataSnapshot;
    aiSummaryStatus: 'pending' | 'complete' | 'fallback';
    generatedAt: number;
  }): void {
    const raw = getRawDatabase(this.db);
    // SQLite's UNIQUE-NULL semantics force two separate UPSERT paths here:
    // rows persisted with `preset_id IS NULL` (backfill + daily cron) are
    // deduped via the `ux_daily_reports_channel_level` partial index, while
    // preset-specific rows use `ux_daily_reports_preset`. Collapsing these
    // into a single `ON CONFLICT(channel, report_date, preset_id)` would
    // silently let NULL rows duplicate, since SQLite treats each NULL as
    // distinct for a standard UNIQUE constraint.
    if (input.presetId === null) {
      raw
        .prepare(
          `INSERT INTO daily_reports (channel, report_date, period, preset_id, snapshot_json, ai_summary_status, generated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(channel, report_date) WHERE preset_id IS NULL DO UPDATE SET
             period = excluded.period,
             snapshot_json = excluded.snapshot_json,
             ai_summary_status = excluded.ai_summary_status,
             generated_at = excluded.generated_at`,
        )
        .run(
          input.channel,
          input.reportDate,
          input.period,
          JSON.stringify(input.snapshot),
          input.aiSummaryStatus,
          input.generatedAt,
        );
    } else {
      raw
        .prepare(
          `INSERT INTO daily_reports (channel, report_date, period, preset_id, snapshot_json, ai_summary_status, generated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel, report_date, preset_id) WHERE preset_id IS NOT NULL DO UPDATE SET
             period = excluded.period,
             snapshot_json = excluded.snapshot_json,
             ai_summary_status = excluded.ai_summary_status,
             generated_at = excluded.generated_at`,
        )
        .run(
          input.channel,
          input.reportDate,
          input.period,
          input.presetId,
          JSON.stringify(input.snapshot),
          input.aiSummaryStatus,
          input.generatedAt,
        );
    }
  }

  /**
   * Persist only fully-collected snapshots. Partial engine results are still
   * useful to return to an interactive caller, but writing them into
   * `daily_reports` would overwrite a known-good row with an apparently-valid
   * empty snapshot and suppress later backfill.
   */
  saveGeneratedResult(result: GenerateResult): boolean {
    if (result.status !== 'complete') return false;
    this.saveReport({
      channel: result.snapshot.digestId.channel,
      reportDate: result.snapshot.digestId.date,
      presetId: result.snapshot.digestId.presetId,
      period: result.snapshot.period,
      snapshot: result.snapshot,
      aiSummaryStatus: result.snapshot.aiSummary.status,
      generatedAt: result.snapshot.generatedAt,
    });
    return true;
  }

  /**
   * Render a stored snapshot to Markdown using the caller-chosen slot order
   * and empty-section policy. Exposed on the service so upstream consumers
   * (e.g. the server's `/digest/preview` route) can produce markdown without
   * importing plugin internals.
   *
   * `tz` is omitted from the caller-supplied options because the service
   * already holds a live timezone getter (`getTimezone`) — pulling tz here
   * keeps every render path on the same source of truth as
   * `yesterdayLocalISO()` instead of forcing every caller to thread tz
   * through. If a future caller ever needs to render at a different tz than
   * the global config, accept an override here.
   */
  renderMarkdown(
    snapshot: DataSnapshot,
    options: { language: Language; slots: ChannelSlot[]; skipEmpty: boolean },
  ): string {
    return renderDigestMarkdown(snapshot, { ...options, tz: this.getTimezone() });
  }

  /**
   * Return yesterday's date in the configured tz as ISO `YYYY-MM-DD`. Exposed
   * on the service so all three scheduler paths (data-snapshot / backfill /
   * push) and upstream callers (server's `/digest/preview` default date)
   * compute the same "yesterday" that gets written to `daily_reports`.
   * Previously four call-sites inlined the same expression — a drift risk
   * for a single semantic concept (CLAUDE.md §3 — centralize, don't duplicate).
   *
   * tz is read fresh from `getTimezone()` on every call so a runtime commit
   * of `GOLDPAN_TIMEZONE` hot-reloads without restart.
   */
  yesterdayLocalISO(): string {
    return yesterdayLocalISO(new Date(), this.getTimezone());
  }

  getReport(
    channel: string,
    reportDate: string,
    presetId: number | null,
  ): {
    snapshot: DataSnapshot;
    aiSummaryStatus: 'pending' | 'complete' | 'fallback';
    generatedAt: number;
  } | null {
    const raw = getRawDatabase(this.db);
    const row =
      presetId === null
        ? (raw
            .prepare(
              `SELECT snapshot_json, ai_summary_status, generated_at
             FROM daily_reports WHERE channel = ? AND report_date = ? AND preset_id IS NULL`,
            )
            .get(channel, reportDate) as
            | { snapshot_json: string; ai_summary_status: string; generated_at: number }
            | undefined)
        : (raw
            .prepare(
              `SELECT snapshot_json, ai_summary_status, generated_at
             FROM daily_reports WHERE channel = ? AND report_date = ? AND preset_id = ?`,
            )
            .get(channel, reportDate, presetId) as
            | { snapshot_json: string; ai_summary_status: string; generated_at: number }
            | undefined);
    if (!row) return null;
    return {
      snapshot: JSON.parse(row.snapshot_json) as DataSnapshot,
      aiSummaryStatus: row.ai_summary_status as 'pending' | 'complete' | 'fallback',
      generatedAt: row.generated_at,
    };
  }

  getReportById(id: number): {
    channel: string;
    reportDate: string;
    presetId: number | null;
    snapshot: DataSnapshot;
    aiSummaryStatus: 'pending' | 'complete' | 'fallback';
    generatedAt: number;
  } | null {
    const raw = getRawDatabase(this.db);
    const row = raw
      .prepare(
        `SELECT id, channel, report_date, preset_id, snapshot_json, ai_summary_status, generated_at
         FROM daily_reports WHERE id = ?`,
      )
      .get(id) as
      | {
          id: number;
          channel: string;
          report_date: string;
          preset_id: number | null;
          snapshot_json: string;
          ai_summary_status: string;
          generated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      channel: row.channel,
      reportDate: row.report_date,
      presetId: row.preset_id,
      snapshot: JSON.parse(row.snapshot_json) as DataSnapshot,
      aiSummaryStatus: row.ai_summary_status as 'pending' | 'complete' | 'fallback',
      generatedAt: row.generated_at,
    };
  }

  getReportRowId(channel: string, reportDate: string, presetId: number | null): number | null {
    const raw = getRawDatabase(this.db);
    const row =
      presetId === null
        ? raw
            .prepare(
              `SELECT id FROM daily_reports WHERE channel = ? AND report_date = ? AND preset_id IS NULL`,
            )
            .get(channel, reportDate)
        : raw
            .prepare(
              `SELECT id FROM daily_reports WHERE channel = ? AND report_date = ? AND preset_id = ?`,
            )
            .get(channel, reportDate, presetId);
    return row ? (row as { id: number }).id : null;
  }
}
