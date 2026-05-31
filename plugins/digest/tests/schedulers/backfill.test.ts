import { describe, expect, it, vi } from 'vitest';
import { backfillMissing } from '../../src/schedulers/backfill.js';
import type { DigestId, GenerateResult } from '../../src/types.js';

function fakeGenerateResult(id: DigestId): GenerateResult {
  return {
    status: 'complete',
    snapshot: {
      digestId: id,
      period: 'daily',
      generatedAt: 0,
      modules: {
        tracking_findings: { type: 'tracking_findings', items: [], hasMore: false, hiddenCount: 0 },
        captures: { type: 'captures', items: [], hasMore: false, hiddenCount: 0 },
        thoughts: { type: 'thoughts', items: [], hasMore: false, hiddenCount: 0 },
        new_entities: { type: 'new_entities', items: [], hasMore: false, hiddenCount: 0 },
        stats: { type: 'stats', captures: 0, findings: 0, thoughts: 0, entities: 0 },
      },
      aiSummary: { status: 'fallback', text: '' },
    },
  };
}

describe('backfillMissing', () => {
  it('calls generate for each missing channel with includeAiSummary=true', async () => {
    const generate = vi.fn(async (id: DigestId) => fakeGenerateResult(id));
    const saveReport = vi.fn();
    await backfillMissing({
      generate,
      getMissing: () => ['telegram', 'web'],
      date: '2026-04-19',
      saveReport,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenNthCalledWith(
      1,
      { channel: 'telegram', date: '2026-04-19', presetId: null },
      { includeAiSummary: true },
    );
    expect(generate).toHaveBeenNthCalledWith(
      2,
      { channel: 'web', date: '2026-04-19', presetId: null },
      { includeAiSummary: true },
    );
  });

  it('persists each generated snapshot via saveReport (P0-1)', async () => {
    const generate = vi.fn(async (id: DigestId) => fakeGenerateResult(id));
    const saveReport = vi.fn();
    await backfillMissing({
      generate,
      getMissing: () => ['telegram', 'web'],
      date: '2026-04-19',
      saveReport,
    });
    expect(saveReport).toHaveBeenCalledTimes(2);
    expect(saveReport.mock.calls[0][0]).toBe('telegram');
    expect(saveReport.mock.calls[1][0]).toBe('web');
    // Each result is the GenerateResult for the corresponding channel.
    expect(saveReport.mock.calls[0][1].snapshot.digestId.channel).toBe('telegram');
  });

  it('skips generate entirely when no channels are missing', async () => {
    const generate = vi.fn(async (id: DigestId) => fakeGenerateResult(id));
    const saveReport = vi.fn();
    await backfillMissing({
      generate,
      getMissing: () => [],
      date: '2026-04-19',
      saveReport,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(saveReport).not.toHaveBeenCalled();
  });

  it('isolates per-channel errors and logs via provided logger (P1-6)', async () => {
    const generate = vi.fn(async (id: DigestId) => {
      if (id.channel === 'telegram') {
        throw new Error('boom');
      }
      return fakeGenerateResult(id);
    });
    const saveReport = vi.fn();
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof backfillMissing>[0]['logger'];
    await expect(
      backfillMissing({
        generate,
        getMissing: () => ['telegram', 'web'],
        date: '2026-04-19',
        saveReport,
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].channel).toBe('web');
    // Only the successful channel writes a report.
    expect(saveReport).toHaveBeenCalledTimes(1);
    expect(saveReport.mock.calls[0][0]).toBe('web');
    // The failure is logged (no longer swallowed).
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, payload] = warn.mock.calls[0];
    expect(String(message)).toMatch(/backfill/i);
    expect(payload).toMatchObject({ channelId: 'telegram', error: 'boom' });
  });
});
