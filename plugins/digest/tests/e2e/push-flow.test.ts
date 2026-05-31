import { describe, expect, it, vi } from 'vitest';
import { ensureDigestTables } from '../../src/db.js';
import { DigestEngine } from '../../src/engine.js';
import { handleDigestAction } from '../../src/im/handler.js';
import { createPushScheduler } from '../../src/schedulers/push.js';
import { DigestCrudService } from '../../src/service.js';
import { makeTestDbWithMetadata, seedDigestFixture } from '../fixtures/seed.js';

describe('E2E: IM subscribe → push', () => {
  it('subscribe via IM action → push scheduler emits sendOutbound at push_time and dedups on replay', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    try {
      ensureDigestTables(db);
      const yesterday = '2026-04-17';
      seedDigestFixture(db, { dateISO: yesterday, captures: 1 });
      const service = new DigestCrudService({ db, getTimezone: () => 'UTC' });
      service.seedDefaultPresets('telegram');

      // 1) Subscribe via the IM action handler.
      const ref = { channelId: 'telegram', accountId: 'a', chatId: 'c', userId: 'u' };
      await handleDigestAction({
        action: { kind: 'subscribe', presetName: 'daily_default', pushTime: '09:00' },
        language: 'en',
        service,
        ref,
      });
      expect(service.listSubscriptions(ref)).toHaveLength(1);

      const engine = new DigestEngine({
        db,
        getMaxItemsPerModule: () => 10,
        getSnapshot: async (id) => ({
          digestId: id,
          period: 'daily' as const,
          range: {
            from: new Date(`${id.date}T00:00:00Z`).getTime(),
            to: new Date(`${id.date}T23:59:59.999Z`).getTime(),
          },
        }),
      });

      const sendOutbound = vi.fn(async () => {});
      const scheduler = createPushScheduler({
        listDueSubscriptions: () => service.listAllActiveSubscriptions(),
        getPreset: (id) => service.getPreset(id),
        generate: (id) => engine.generate(id, { includeAiSummary: false }),
        isFullyEmpty: () => false,
        renderIM: () => 'digest body',
        sendOutbound,
        markPushed: (id, at) => service.markPushed(id, at),
        saveReport: (channel, result) =>
          service.saveReport({
            channel,
            reportDate: result.snapshot.digestId.date,
            presetId: result.snapshot.digestId.presetId,
            period: result.snapshot.period,
            snapshot: result.snapshot,
            aiSummaryStatus: result.snapshot.aiSummary.status,
            generatedAt: result.snapshot.generatedAt,
          }),
        getTimezone: () => 'UTC',
        now: () => new Date('2026-04-18T09:00:30Z'),
        getReportRowId: (channel, date, presetId) =>
          service.getReportRowId(channel, date, presetId),
        signingKey: 'a'.repeat(32),
        ttlDays: 14,
        publicBaseUrl: 'https://digest.example.com',
      });

      // 2) First runOnce triggers exactly one sendOutbound on the telegram channel.
      await scheduler.runOnce();
      expect(sendOutbound).toHaveBeenCalledTimes(1);
      expect(sendOutbound.mock.calls[0][0]).toBe('telegram');

      // 3) lastPushedAt was updated.
      const subsAfterPush = service.listSubscriptions(ref);
      expect(subsAfterPush).toHaveLength(1);
      expect(subsAfterPush[0].lastPushedAt).not.toBeNull();
      expect(subsAfterPush[0].lastPushedAt as number).toBeGreaterThan(0);

      // 3.5) daily_reports now contains the pushed snapshot (P0-1 regression).
      const defaultPreset = service.listPresets('telegram').find((p) => p.isDefault);
      expect(defaultPreset).toBeDefined();
      const stored = service.getReport('telegram', yesterday, defaultPreset!.id);
      expect(stored).not.toBeNull();
      expect(stored?.snapshot.digestId.channel).toBe('telegram');

      // 4) Second runOnce within the same day does NOT re-fire sendOutbound (dedup).
      await scheduler.runOnce();
      expect(sendOutbound).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
