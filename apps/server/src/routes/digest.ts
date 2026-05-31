import { mintShareUrl, verifyShareSig } from '@goldpan/core/digest-link/sign';
import { z } from 'zod';
import {
  getErrorCode,
  parseId,
  parseJsonBody,
  type RouteContext,
  respond,
  respondError,
} from './types.js';

interface DigestReport {
  snapshot: unknown;
  aiSummaryStatus: 'pending' | 'complete' | 'fallback';
  generatedAt: number;
}

interface DigestPreset {
  id: number;
  channel: string;
  name: string;
  period: string;
  pushDay: number | null;
  pushTime: string;
  windowMode: 'calendar' | 'rolling';
  slots: string[];
  skipEmpty: boolean;
  includeAiSummary: boolean;
  isDefault: boolean;
}

// HH:MM 24h:hours 00–23,minutes 00–59。和 plugins/digest/src/im/action-parser.schema.ts
// 的 TIME_HHMM_RE 一致 —— "08:00" / "23:59" 接受,"24:00" / "08:5" 拒绝。
const PUSH_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const PresetInputSchema = z.object({
  name: z.string().min(1),
  period: z.enum(['daily', 'weekly']),
  pushDay: z.number().int().min(1).max(7).nullable(),
  pushTime: z.string().regex(PUSH_TIME_RE, 'pushTime must be HH:MM (24h)'),
  windowMode: z.enum(['calendar', 'rolling']),
  slots: z
    .array(
      z.enum(['tracking_findings', 'captures', 'thoughts', 'new_entities', 'stats', 'ai_summary']),
    )
    // 重复 slot 在 DigestSections 渲染端会触发 React key 冲突 + 双渲染同一 section,
    // 产品语义上重复 slot 也无意义。在边界处拒绝。
    .refine((arr) => new Set(arr).size === arr.length, { message: 'slots must be unique' }),
  skipEmpty: z.boolean(),
  includeAiSummary: z.boolean(),
  isDefault: z.boolean(),
});

const PresetPatchSchema = PresetInputSchema.partial();

const ShareLinkInputSchema = z.object({
  channel: z.string().min(1).default('web'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  presetId: z.number().int().positive().nullable().optional(),
});

type PresetInput = z.infer<typeof PresetInputSchema>;
type PresetPatchInput = z.infer<typeof PresetPatchSchema>;

/**
 * Projection over the plugin-internal `DataSnapshot` covering only the
 * fields this route reads back. Keeping it narrow (no `modules`,
 * `digestId`, `period`, etc.) means a downstream rename in the plugin's
 * snapshot shape can't silently drift from this handwritten mirror — the
 * full snapshot travels through the response as `unknown`.
 */
interface DigestRegenerateSnapshot {
  generatedAt: number;
  aiSummary: { status: 'pending' | 'complete' | 'fallback' };
}

interface DigestServiceAPI {
  getReport(channel: string, reportDate: string, presetId: number | null): DigestReport | null;
  /** Lookup a preset by id. Returns null when no row matches (deleted or never existed). */
  getPreset(id: number): DigestPreset | null;
  listPresets(channel: string): DigestPreset[];
  createPreset(channel: string, input: PresetInput): DigestPreset;
  updatePreset(id: number, input: PresetPatchInput): DigestPreset;
  deletePreset(id: number): void;
  /**
   * Force a fresh snapshot via the engine and persist it to `daily_reports`.
   * Used by `GET /digest/preview?forceRegenerate=true` (the UI Regenerate
   * button). Throws `regenerator_not_attached` when the plugin is enabled
   * but `postInit` has not yet wired the engine — callers should map that
   * to a 503 so retries surface the transient window.
   */
  regenerateAndSave(
    channel: string,
    date: string,
    presetId: number | null,
  ): Promise<DigestRegenerateSnapshot>;
  /**
   * Yesterday's date in the configured tz as ISO `YYYY-MM-DD`. Single source
   * of truth shared with the plugin's schedulers so `/digest/preview` without
   * `?date=` lands on the same row the schedulers persisted (see plugin's
   * `DigestCrudService.yesterdayLocalISO`).
   */
  yesterdayLocalISO(): string;
  getReportById(id: number): {
    channel: string;
    reportDate: string;
    presetId: number | null;
    snapshot: unknown;
    aiSummaryStatus: 'pending' | 'complete' | 'fallback';
    generatedAt: number;
  } | null;
  getReportRowId(channel: string, reportDate: string, presetId: number | null): number | null;
}

function canFallbackToChannelSnapshot(
  presetId: number | null,
  requestedPreset: DigestPreset | null,
): boolean {
  if (presetId === null) return true;
  return requestedPreset?.period === 'daily' && requestedPreset.windowMode === 'calendar';
}

function toSharePreset(preset: DigestPreset | null) {
  return preset
    ? {
        slots: preset.slots,
        skipEmpty: preset.skipEmpty,
        includeAiSummary: preset.includeAiSummary,
        period: preset.period,
      }
    : null;
}

/**
 * Handle /digest/* routes. Gated by `config.digest.enabled` — returns 503
 * `plugin_disabled` when off.
 *
 * Exception: `GET /digest/share/:id` bypasses the enabled-check and auth
 * (auth bypass is handled in main.ts by routing to this function BEFORE the
 * `authRequired()` guard). The HMAC signature is the sole access control.
 */
export async function handleDigestRoutes(ctx: RouteContext): Promise<void> {
  const { req, res, segments, handle, readBody } = ctx;

  if (segments[0] === 'share' && segments.length === 2) {
    // 入口处 set headers 覆盖所有响应分支:防代理缓存 410 + 防搜索引擎索引错误页。
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    req.resume();
    const digestIdSegment = segments[1];
    if (req.method !== 'GET') {
      handle.logger.warn('digest share rejected', {
        reason: 'method_not_allowed',
        method: req.method,
        digestId: digestIdSegment,
      });
      respondError(res, 405, 'method_not_allowed', 'Method not allowed');
      return;
    }
    const signingKey = handle.config.digest.linkSigningKey;
    if (!signingKey) {
      handle.logger.warn('digest share rejected', {
        reason: 'signing_key_unconfigured',
        digestId: digestIdSegment,
      });
      respondError(res, 410, 'share_link_invalid', 'Link expired or tampered');
      return;
    }
    const id = parseId(digestIdSegment);
    if (id === null) {
      handle.logger.warn('digest share rejected', {
        reason: 'malformed_id',
        digestId: digestIdSegment,
      });
      respondError(res, 400, 'share_link_malformed', 'Malformed digest id in path');
      return;
    }
    const sigParam = ctx.url.searchParams.get('sig');
    if (!sigParam) {
      handle.logger.warn('digest share rejected', { reason: 'sig_missing', digestId: id });
      respondError(res, 400, 'share_link_malformed', 'Missing or malformed sig parameter');
      return;
    }
    const verifyResult = verifyShareSig({ digestId: id, sigParam, signingKey });
    if (!verifyResult.ok) {
      handle.logger.warn('digest share rejected', {
        reason: verifyResult.reason === 'malformed' ? 'sig_malformed' : 'sig_expired_or_tampered',
        digestId: id,
      });
      if (verifyResult.reason === 'malformed') {
        respondError(res, 400, 'share_link_malformed', 'Missing or malformed sig parameter');
      } else {
        respondError(res, 410, 'share_link_invalid', 'Link expired or tampered');
      }
      return;
    }
    const shareService = handle.pluginRegistry.getService<DigestServiceAPI>('digest');
    if (!shareService) {
      handle.logger.warn('digest share rejected', { reason: 'service_unavailable', digestId: id });
      respondError(res, 503, 'plugin_disabled', 'digest service not registered');
      return;
    }
    const row = shareService.getReportById(id);
    if (!row) {
      handle.logger.warn('digest share rejected', { reason: 'row_not_found', digestId: id });
      respondError(res, 410, 'share_link_invalid', 'Link expired or tampered');
      return;
    }
    // row.presetId === null → channel-level snapshot. A signed payload may
    // still carry pid when the link was minted from a preset preview that fell
    // back to that channel row; use it only for rendering composition.
    let sharePreset: DigestPreset | null = null;
    const renderPresetId = row.presetId ?? verifyResult.payload.pid ?? null;
    if (renderPresetId !== null) {
      sharePreset = shareService.getPreset(renderPresetId);
      if (sharePreset === null) {
        handle.logger.warn('digest share: preset deleted, falling back to default render', {
          digestId: id,
          presetId: renderPresetId,
        });
      } else if (sharePreset.channel !== row.channel) {
        handle.logger.warn(
          'digest share: preset channel mismatch, falling back to default render',
          {
            digestId: id,
            presetId: renderPresetId,
            rowChannel: row.channel,
            presetChannel: sharePreset.channel,
          },
        );
        sharePreset = null;
      }
    }
    respond(res, 200, {
      snapshot: row.snapshot,
      generatedAt: row.generatedAt,
      status: row.aiSummaryStatus === 'pending' ? 'pending' : 'cached',
      channel: row.channel,
      date: row.reportDate,
      presetId: row.presetId,
      preset: toSharePreset(sharePreset),
    });
    return;
  }

  if (!handle.config.digest.enabled) {
    req.resume();
    respondError(res, 503, 'plugin_disabled', 'digest plugin disabled');
    return;
  }

  const service = handle.pluginRegistry.getService<DigestServiceAPI>('digest');
  if (!service) {
    req.resume();
    respondError(res, 503, 'plugin_disabled', 'digest service not registered');
    return;
  }

  // GET /digest/preview
  if (req.method === 'GET' && segments[0] === 'preview' && segments.length === 1) {
    req.resume();
    try {
      const channel = ctx.url.searchParams.get('channel') ?? 'web';
      // Default to *yesterday* UTC: the data-snapshot / backfill / push schedulers
      // all persist yesterday-UTC snapshots, and a freshly-loaded /digest page
      // with no `?date=` should show that persisted row rather than today (which
      // is always empty until the next daily cron). Delegate to the service so
      // all four "yesterday" computations agree.
      const date = ctx.url.searchParams.get('date') ?? service.yesterdayLocalISO();
      const presetIdRaw = ctx.url.searchParams.get('presetId');
      const presetId = presetIdRaw ? parseId(presetIdRaw) : null;
      if (presetIdRaw && presetId === null) {
        respondError(res, 400, 'invalid_id', 'Invalid preset ID');
        return;
      }
      const forceRegenerate = ctx.url.searchParams.get('forceRegenerate') === 'true';
      const presets: DigestPreset[] = service.listPresets(channel);
      const requestedPreset: DigestPreset | null =
        presetId !== null ? (presets.find((p: DigestPreset) => p.id === presetId) ?? null) : null;
      if (presetId !== null && !requestedPreset) {
        respondError(res, 404, 'preset_not_found', 'Preset not found');
        return;
      }

      interface PreviewSnapshot {
        snapshot: unknown;
        generatedAt: number;
        aiSummaryStatus: 'pending' | 'complete' | 'fallback';
      }

      let resolved: PreviewSnapshot | null = null;
      if (forceRegenerate) {
        // The "Regenerate" button: re-collect modules + LLM summary and
        // overwrite `daily_reports`. Surface the engine's "not yet wired"
        // transition window as 503 so the UI can retry; other failures fall
        // through to the generic 500 below.
        try {
          const snapshot = await service.regenerateAndSave(channel, date, presetId);
          resolved = {
            snapshot,
            generatedAt: snapshot.generatedAt,
            aiSummaryStatus: snapshot.aiSummary.status,
          };
        } catch (err) {
          if (getErrorCode(err) === 'regenerator_not_attached') {
            respondError(res, 503, 'plugin_disabled', 'digest engine not ready — retry shortly');
            return;
          }
          throw err;
        }
      } else {
        // Normal preview read. Backfill + the daily cron persist the
        // channel-level snapshot with `preset_id IS NULL`; the push
        // scheduler writes preset-specific rows. A fresh deploy only has
        // the channel-level row, so daily calendar presets may fall back to
        // `presetId=null` when the preset-specific lookup misses. Weekly and
        // rolling presets must NOT reuse that deterministic calendar row.
        const shouldFallbackToChannelSnapshot = canFallbackToChannelSnapshot(
          presetId,
          requestedPreset,
        );
        const report =
          service.getReport(channel, date, presetId) ??
          (presetId !== null && shouldFallbackToChannelSnapshot
            ? service.getReport(channel, date, null)
            : null);
        if (report) {
          resolved = {
            snapshot: report.snapshot,
            generatedAt: report.generatedAt,
            aiSummaryStatus: report.aiSummaryStatus,
          };
        }
      }

      if (!resolved) {
        respond(res, 200, {
          snapshot: null,
          generatedAt: null,
          status: 'missing',
        });
        return;
      }
      // Map the plugin-internal `aiSummaryStatus` ('pending' | 'complete' |
      // 'fallback') to the SDK's `DigestSnapshotStatus` wire union ('cached' |
      // 'generated' | 'missing' | 'pending'). 'pending' passes through; a
      // forced regenerate tags 'generated' so a polling client can tell a
      // fresh snapshot from a cache hit; everything else folds into 'cached'.
      // The share branch above does the same mapping.
      const status: 'cached' | 'generated' | 'pending' =
        resolved.aiSummaryStatus === 'pending'
          ? 'pending'
          : forceRegenerate
            ? 'generated'
            : 'cached';
      respond(res, 200, {
        snapshot: resolved.snapshot,
        generatedAt: resolved.generatedAt,
        status,
      });
    } catch (err) {
      handle.logger.error('GET /digest/preview failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // POST /digest/share-link
  // Mints a signed read-only share URL for a given (channel, date, presetId).
  // Requires both `linkSigningKey` (≥32 chars) AND `publicBaseUrl` to be
  // configured — otherwise the IM-side share-link footer is also disabled,
  // so we 503 with a descriptive code so the UI can surface a "configure
  // these env vars" hint instead of failing silently.
  if (req.method === 'POST' && segments[0] === 'share-link' && segments.length === 1) {
    const body = await readBody();
    if (body === null) return;
    const parsed = parseJsonBody<unknown>(res, body);
    if (parsed === null) return;
    const result = ShareLinkInputSchema.safeParse(parsed);
    if (!result.success) {
      respondError(res, 400, 'invalid_input', result.error.message);
      return;
    }
    const signingKey = handle.config.digest.linkSigningKey;
    const publicBaseUrl = handle.config.digest.publicBaseUrl;
    const ttlDays = handle.config.digest.linkTtlDays;
    if (!signingKey || !publicBaseUrl) {
      respondError(
        res,
        503,
        'share_link_disabled',
        'Share link unavailable — set GOLDPAN_DIGEST_LINK_SIGNING_KEY and GOLDPAN_DIGEST_PUBLIC_BASE_URL',
      );
      return;
    }
    const presetId = result.data.presetId ?? null;
    const requestedPreset =
      presetId !== null
        ? (service.listPresets(result.data.channel).find((p: DigestPreset) => p.id === presetId) ??
          null)
        : null;
    const rowId =
      service.getReportRowId(result.data.channel, result.data.date, presetId) ??
      (presetId !== null && canFallbackToChannelSnapshot(presetId, requestedPreset)
        ? service.getReportRowId(result.data.channel, result.data.date, null)
        : null);
    if (rowId === null) {
      respondError(res, 404, 'snapshot_not_found', 'No digest snapshot for the given key');
      return;
    }
    try {
      const url = mintShareUrl({
        digestId: rowId,
        presetId,
        signingKey,
        ttlDays,
        publicBaseUrl,
      });
      respond(res, 200, { url, ttlDays });
    } catch (err) {
      handle.logger.error('POST /digest/share-link failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // GET /digest/presets
  if (req.method === 'GET' && segments[0] === 'presets' && segments.length === 1) {
    req.resume();
    try {
      const channel = ctx.url.searchParams.get('channel') ?? 'web';
      respond(res, 200, { presets: service.listPresets(channel) });
    } catch (err) {
      handle.logger.error('GET /digest/presets failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // POST /digest/presets?channel=X
  if (req.method === 'POST' && segments[0] === 'presets' && segments.length === 1) {
    const body = await readBody();
    if (body === null) return;
    const parsed = parseJsonBody<unknown>(res, body);
    if (parsed === null) return;

    const channel = ctx.url.searchParams.get('channel') ?? 'web';
    const result = PresetInputSchema.safeParse(parsed);
    if (!result.success) {
      respondError(res, 400, 'invalid_input', result.error.message);
      return;
    }
    try {
      const preset = service.createPreset(channel, result.data);
      respond(res, 201, { preset });
    } catch (err) {
      handle.logger.error('POST /digest/presets failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // PATCH /digest/presets/:id
  if (req.method === 'PATCH' && segments[0] === 'presets' && segments.length === 2) {
    const id = parseId(segments[1]);
    if (id === null) {
      req.resume();
      respondError(res, 400, 'invalid_id', 'Invalid preset ID');
      return;
    }
    const body = await readBody();
    if (body === null) return;
    const parsed = parseJsonBody<unknown>(res, body);
    if (parsed === null) return;
    const result = PresetPatchSchema.safeParse(parsed);
    if (!result.success) {
      respondError(res, 400, 'invalid_input', result.error.message);
      return;
    }
    try {
      const preset = service.updatePreset(id, result.data);
      respond(res, 200, { preset });
    } catch (err) {
      if (getErrorCode(err) === 'preset_not_found') {
        respondError(res, 404, 'preset_not_found', 'Preset not found');
        return;
      }
      handle.logger.error('PATCH /digest/presets failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // DELETE /digest/presets/:id
  if (req.method === 'DELETE' && segments[0] === 'presets' && segments.length === 2) {
    req.resume();
    const id = parseId(segments[1]);
    if (id === null) {
      respondError(res, 400, 'invalid_id', 'Invalid preset ID');
      return;
    }
    try {
      service.deletePreset(id);
      respond(res, 200, { ok: true });
    } catch (err) {
      const code = getErrorCode(err);
      if (code === 'preset_in_use' && err instanceof Error) {
        const usages = (err as { usages?: unknown[] }).usages ?? [];
        respond(res, 409, {
          type: 'error',
          code: 'preset_in_use',
          message: err.message,
          usages,
        });
        return;
      }
      if (code === 'preset_not_found') {
        respondError(res, 404, 'preset_not_found', 'Preset not found');
        return;
      }
      handle.logger.error('DELETE /digest/presets failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // GET /digest/connections
  if (segments[0] === 'connections' && segments.length === 1) {
    req.resume();
    if (req.method !== 'GET') {
      respondError(res, 405, 'method_not_allowed', 'Method not allowed');
      return;
    }
    const sinceRaw = ctx.url.searchParams.get('since');
    const limitRaw = ctx.url.searchParams.get('limit');
    // 拒空串 (Number('')=0 会过 isInteger);上限 8.64e15 = JS Date 上界,
    // 超出 toISOString 抛 RangeError → 500。
    const MAX_SAFE_DATE_MS = 8_640_000_000_000_000;
    if (sinceRaw === null || sinceRaw === '') {
      respondError(res, 400, 'invalid_since', '`since` is required (ms epoch integer)');
      return;
    }
    const since = Number(sinceRaw);
    if (!Number.isSafeInteger(since) || since < 0 || since > MAX_SAFE_DATE_MS) {
      respondError(
        res,
        400,
        'invalid_since',
        '`since` must be a safe integer in [0, 8.64e15] (ms epoch)',
      );
      return;
    }
    const limit = limitRaw === null ? 5 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      respondError(res, 400, 'invalid_limit', '`limit` must be 1-50');
      return;
    }
    try {
      const rows = handle.repos.knowledge.findRecentRelations({ sinceMs: since, limit });
      respond(res, 200, { data: rows, total: rows.length });
    } catch (err) {
      handle.logger.error('GET /digest/connections failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // GET /digest/history/:date
  if (req.method === 'GET' && segments[0] === 'history' && segments.length === 2) {
    req.resume();
    try {
      const date = segments[1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        respondError(res, 400, 'invalid_date', 'date must be YYYY-MM-DD');
        return;
      }
      const channel = ctx.url.searchParams.get('channel') ?? 'web';
      const presetIdRaw = ctx.url.searchParams.get('presetId');
      const presetId = presetIdRaw ? parseId(presetIdRaw) : null;
      const report = service.getReport(channel, date, presetId);
      if (!report) {
        respond(res, 200, { snapshot: null });
        return;
      }
      respond(res, 200, { snapshot: report.snapshot });
    } catch (err) {
      handle.logger.error('GET /digest/history failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  req.resume();
  respondError(res, 404, 'not_found', 'Not found');
}
