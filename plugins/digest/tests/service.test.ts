import { describe, expect, it } from 'vitest';
import { ensureDigestTables } from '../src/db.js';
import { DigestCrudService } from '../src/service.js';
import type { GenerateResult } from '../src/types.js';
import { makeTestDbWithMetadata } from './fixtures/seed.js';

function makeService() {
  const { db } = makeTestDbWithMetadata();
  ensureDigestTables(db);
  // `getTimezone` is required by the service constructor (used by
  // `yesterdayLocalISO()`). Service tests pin 'UTC' so date-sensitive
  // assertions don't drift across hosts.
  const service = new DigestCrudService({ db, getTimezone: () => 'UTC' });
  service.seedDefaultPresets('telegram');
  service.seedDefaultPresets('web');
  return { service, db };
}

function makeGeneratedResult(
  overrides: Partial<GenerateResult> & {
    snapshot?: Partial<GenerateResult['snapshot']>;
    snapshotDigestId?: Partial<GenerateResult['snapshot']['digestId']>;
  } = {},
): GenerateResult {
  const digestId = {
    channel: overrides.snapshotDigestId?.channel ?? 'web',
    date: overrides.snapshotDigestId?.date ?? '2026-04-20',
    presetId: overrides.snapshotDigestId?.presetId ?? null,
  };
  return {
    status: overrides.status ?? 'complete',
    snapshot: {
      period: overrides.snapshot?.period ?? 'daily',
      generatedAt: overrides.snapshot?.generatedAt ?? Date.now(),
      modules: {
        tracking_findings: {
          type: 'tracking_findings',
          items: [],
          hasMore: false,
          hiddenCount: 0,
        },
        captures: { type: 'captures', items: [], hasMore: false, hiddenCount: 0 },
        thoughts: { type: 'thoughts', items: [], hasMore: false, hiddenCount: 0 },
        new_entities: { type: 'new_entities', items: [], hasMore: false, hiddenCount: 0 },
        stats: { type: 'stats', captures: 0, findings: 0, thoughts: 0, entities: 0 },
      },
      aiSummary: overrides.snapshot?.aiSummary ?? { status: 'fallback', text: '' },
      ...overrides.snapshot,
      digestId,
    },
  };
}

describe('DigestCrudService', () => {
  it('seeds the 4 default presets idempotently per channel', () => {
    const { service } = makeService();
    service.seedDefaultPresets('telegram');
    const presets = service.listPresets('telegram');
    expect(presets).toHaveLength(4);
    expect(presets.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it('createPreset enforces unique (channel, name)', () => {
    const { service } = makeService();
    service.createPreset('telegram', {
      name: 'custom',
      period: 'daily',
      pushDay: null,
      pushTime: '08:00',
      windowMode: 'calendar',
      slots: ['stats'],
      skipEmpty: true,
      includeAiSummary: false,
      isDefault: false,
    });
    expect(() =>
      service.createPreset('telegram', {
        name: 'custom',
        period: 'daily',
        pushDay: null,
        pushTime: '08:00',
        windowMode: 'calendar',
        slots: ['stats'],
        skipEmpty: true,
        includeAiSummary: false,
        isDefault: false,
      }),
    ).toThrow(/UNIQUE|exists/);
  });

  it('deletePreset throws preset_in_use when a subscription references it', () => {
    const { service } = makeService();
    const [preset] = service.listPresets('telegram');
    service.upsertSubscription({
      channelId: 'telegram',
      accountId: 'a',
      chatId: 'c',
      userId: 'u',
      presetId: preset.id,
      pushTime: '09:00',
    });
    const err = (() => {
      try {
        service.deletePreset(preset.id);
        return null;
      } catch (e) {
        return e as { code?: string; usages?: unknown };
      }
    })();
    expect(err?.code).toBe('preset_in_use');
    expect(Array.isArray(err?.usages)).toBe(true);
  });

  it('upsertSubscription is idempotent on the unique tuple', () => {
    const { service } = makeService();
    const [preset] = service.listPresets('telegram');
    const ref = {
      channelId: 'telegram',
      accountId: 'a',
      chatId: 'c',
      userId: 'u',
      presetId: preset.id,
      pushTime: '09:00',
    };
    const first = service.upsertSubscription(ref);
    const second = service.upsertSubscription({ ...ref, pushTime: '10:00' });
    expect(second.id).toBe(first.id);
    expect(second.pushTime).toBe('10:00');
  });

  it('upsertSubscription rejects presets that belong to a different channel', () => {
    const { service } = makeService();
    const [webPreset] = service.listPresets('web');
    const err = (() => {
      try {
        service.upsertSubscription({
          channelId: 'telegram',
          accountId: 'a',
          chatId: 'c',
          userId: 'u',
          presetId: webPreset.id,
          pushTime: '09:00',
        });
        return null;
      } catch (e) {
        return e as { code?: string };
      }
    })();
    expect(err?.code).toBe('preset_channel_mismatch');
  });

  it('updateSubscription keeps last_pushed_at untouched', () => {
    const { service } = makeService();
    const [preset] = service.listPresets('telegram');
    const sub = service.upsertSubscription({
      channelId: 'telegram',
      accountId: 'a',
      chatId: 'c',
      userId: 'u',
      presetId: preset.id,
      pushTime: '09:00',
    });
    service.markPushed(sub.id, 1234);
    service.updateSubscription(sub.id, { pushTime: '11:00' });
    const after = service.getSubscription(sub.id);
    expect(after?.lastPushedAt).toBe(1234);
    expect(after?.pushTime).toBe('11:00');
  });

  it('updatePreset can flip isDefault=true without UNIQUE conflict — clears previous default first', () => {
    const { service } = makeService();
    // At least one default preset from seedDefaultPresets
    const presets = service.listPresets('telegram');
    const currentDefault = presets.find((p) => p.isDefault);
    const other = presets.find((p) => !p.isDefault);
    expect(currentDefault).toBeTruthy();
    expect(other).toBeTruthy();

    const updated = service.updatePreset(other!.id, { isDefault: true });
    expect(updated.isDefault).toBe(true);
    // Previous default should have been cleared
    const refreshed = service.listPresets('telegram');
    const newDefault = refreshed.find((p) => p.isDefault);
    expect(newDefault?.id).toBe(other!.id);
    expect(refreshed.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it('updatePreset isDefault=false does NOT touch other presets defaults', () => {
    const { service } = makeService();
    const presets = service.listPresets('telegram');
    const currentDefault = presets.find((p) => p.isDefault)!;
    service.updatePreset(currentDefault.id, { isDefault: false });
    const after = service.listPresets('telegram');
    expect(after.filter((p) => p.isDefault)).toHaveLength(0);
  });

  it('renderMarkdown delegates to renderDigestMarkdown and emits the title + heading', () => {
    const { service } = makeService();
    const snapshot = {
      digestId: { channel: 'web', date: '2026-04-20', presetId: null },
      period: 'daily' as const,
      generatedAt: Date.now(),
      modules: {
        tracking_findings: {
          type: 'tracking_findings' as const,
          items: [],
          hasMore: false,
          hiddenCount: 0,
        },
        captures: { type: 'captures' as const, items: [], hasMore: false, hiddenCount: 0 },
        thoughts: { type: 'thoughts' as const, items: [], hasMore: false, hiddenCount: 0 },
        new_entities: {
          type: 'new_entities' as const,
          items: [],
          hasMore: false,
          hiddenCount: 0,
        },
        stats: {
          type: 'stats' as const,
          captures: 3,
          findings: 1,
          thoughts: 0,
          entities: 0,
        },
      },
      aiSummary: { status: 'complete' as const, text: 'Everything went smoothly.' },
    };
    const md = service.renderMarkdown(snapshot, {
      language: 'en',
      slots: ['stats', 'ai_summary'],
      skipEmpty: true,
    });
    expect(md).toContain('Daily Digest');
    expect(md).toContain('2026-04-20');
    expect(md).toContain('Stats');
    expect(md).toContain('Captures: 3');
    expect(md).toContain('Summary');
    expect(md).toContain('Everything went smoothly.');
  });

  it('listChannelsMissingReport only treats channel-level rows as satisfying backfill', () => {
    const { service } = makeService();
    const [preset] = service.listPresets('telegram');
    const result = makeGeneratedResult({
      snapshotDigestId: { channel: 'telegram', date: '2026-04-20', presetId: preset.id },
    });
    service.saveReport({
      channel: 'telegram',
      reportDate: '2026-04-20',
      presetId: preset.id,
      period: result.snapshot.period,
      snapshot: result.snapshot,
      aiSummaryStatus: result.snapshot.aiSummary.status,
      generatedAt: result.snapshot.generatedAt,
    });

    const missing = service.listChannelsMissingReport('2026-04-20');
    expect(missing).toContain('telegram');
    expect(missing).toContain('web');
  });

  it('saveGeneratedResult skips partial snapshots so they do not overwrite stored reports', () => {
    const { service } = makeService();
    const saved = service.saveGeneratedResult(
      makeGeneratedResult({
        status: 'partial',
        snapshotDigestId: { channel: 'web', date: '2026-04-20', presetId: null },
      }),
    );
    expect(saved).toBe(false);
    expect(service.getReport('web', '2026-04-20', null)).toBeNull();
  });

  it('saveGeneratedResult persists under the snapshot channel, not an out-of-band arg', () => {
    // The scheduler/backfill `saveReport` callbacks take a `channel` arg but
    // the plugin's `persistSnapshot` forwards only the result, so the row
    // must be written under `result.snapshot.digestId.channel`. Locks the
    // invariant that a future refactor cannot silently switch to the arg.
    const { service } = makeService();
    const saved = service.saveGeneratedResult(
      makeGeneratedResult({
        snapshotDigestId: { channel: 'telegram', date: '2026-04-20', presetId: null },
      }),
    );
    expect(saved).toBe(true);
    expect(service.getReport('telegram', '2026-04-20', null)).not.toBeNull();
    expect(service.getReport('web', '2026-04-20', null)).toBeNull();
  });

  it('regenerateAndSave throws regenerator_not_attached when postInit has not run', async () => {
    // 503-path regression lock: the route reads this error code to surface
    // a retry-able 503 during the narrow startup window where the plugin
    // is registered but postInit has not yet called attachRegenerator.
    const { service } = makeService();
    await expect(service.regenerateAndSave('web', '2026-04-20', null)).rejects.toMatchObject({
      code: 'regenerator_not_attached',
    });
  });

  it('regenerateAndSave derives includeAiSummary from the target preset', async () => {
    const { service } = makeService();
    const preset = service.createPreset('web', {
      name: 'no-ai',
      period: 'daily',
      pushDay: null,
      pushTime: '08:00',
      windowMode: 'calendar',
      slots: ['stats'],
      skipEmpty: true,
      includeAiSummary: false,
      isDefault: false,
    });
    const seen: Array<{ includeAiSummary: boolean }> = [];
    service.attachRegenerator(async (channel, date, presetId, opts) => {
      seen.push(opts);
      return makeGeneratedResult({
        snapshotDigestId: { channel, date, presetId },
      });
    });

    await service.regenerateAndSave('web', '2026-04-20', preset.id);

    expect(seen).toEqual([{ includeAiSummary: false }]);
    expect(service.getReport('web', '2026-04-20', preset.id)).not.toBeNull();
  });

  it('regenerateAndSave single-flights concurrent requests for the same key', async () => {
    // Two concurrent "Regenerate" clicks for the same (channel, date,
    // preset) must share one underlying engine call — otherwise each
    // request re-collects modules + pays the AI-summary LLM cost and
    // their concurrent UPSERTs race. Different keys must NOT share.
    const { service } = makeService();
    const calls: Array<[string, string, number | null]> = [];
    let resolveFn!: (value: unknown) => void;
    const gate = new Promise((r) => {
      resolveFn = r;
    });
    const regenerator = async (channel: string, date: string, presetId: number | null) => {
      calls.push([channel, date, presetId]);
      await gate;
      return {
        snapshot: {
          digestId: { channel, date, presetId },
          period: 'daily' as const,
          generatedAt: Date.now(),
          modules: {
            tracking_findings: {
              type: 'tracking_findings' as const,
              items: [],
              hasMore: false,
              hiddenCount: 0,
            },
            captures: {
              type: 'captures' as const,
              items: [],
              hasMore: false,
              hiddenCount: 0,
            },
            thoughts: {
              type: 'thoughts' as const,
              items: [],
              hasMore: false,
              hiddenCount: 0,
            },
            new_entities: {
              type: 'new_entities' as const,
              items: [],
              hasMore: false,
              hiddenCount: 0,
            },
            stats: {
              type: 'stats' as const,
              captures: 0,
              findings: 0,
              thoughts: 0,
              entities: 0,
            },
          },
          aiSummary: { status: 'complete' as const, text: '' },
        },
        status: 'complete' as const,
      };
    };
    service.attachRegenerator(regenerator);
    // Fire 3 concurrent requests for the same key + 1 for a different key.
    const p1 = service.regenerateAndSave('web', '2026-04-20', null);
    const p2 = service.regenerateAndSave('web', '2026-04-20', null);
    const p3 = service.regenerateAndSave('web', '2026-04-20', null);
    const pOther = service.regenerateAndSave('telegram', '2026-04-20', null);
    resolveFn(null);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3, pOther]);
    // The three same-key callers share one engine call; the different-key
    // caller runs separately. Total: 2 engine calls.
    expect(calls).toHaveLength(2);
    // Same-key requests resolve to the same snapshot reference.
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });
});
