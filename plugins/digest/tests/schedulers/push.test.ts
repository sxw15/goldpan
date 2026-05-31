import { verifyShareSig } from '@goldpan/core/digest-link/sign';
import { describe, expect, it, vi } from 'vitest';
import { createPushScheduler } from '../../src/schedulers/push.js';
import type { DataSnapshot, DigestPresetRow, DigestSubscriptionRow } from '../../src/types.js';

/** Minimal link-signing deps for tests that reach outbound construction. */
function makeLinkDeps() {
  return {
    getReportRowId: (): number => 42,
    signingKey: 'a'.repeat(32),
    ttlDays: 14,
    publicBaseUrl: 'https://digest.example.com',
  };
}

function makePreset(over: Partial<DigestPresetRow> = {}): DigestPresetRow {
  return {
    id: 1,
    channel: 'telegram',
    name: 'x',
    period: 'daily',
    pushDay: null,
    pushTime: '08:00',
    windowMode: 'calendar',
    slots: [],
    skipEmpty: false,
    includeAiSummary: false,
    isDefault: true,
    ...over,
  };
}

function makeSub(over: Partial<DigestSubscriptionRow> = {}): DigestSubscriptionRow {
  return {
    id: 1,
    channelId: 'telegram',
    accountId: 'a',
    chatId: 'c',
    userId: 'u',
    presetId: 1,
    pushTime: '09:00',
    paused: false,
    lastPushedAt: null,
    ...over,
  };
}

function dummySnapshot(): DataSnapshot {
  return {
    digestId: { channel: 'telegram', date: '2026-04-17', presetId: 1 },
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
  };
}

describe('PushScheduler.runOnce', () => {
  const now = new Date('2026-04-18T09:01:00Z');

  it('S11: minted share URL in IM push outbound is verifiable by verifyShareSig (sign↔verify roundtrip)', async () => {
    let capturedBody: string | null = null;
    const sendOutbound = vi.fn(async (_chan, _ref, result) => {
      if (result.type === 'content') capturedBody = result.text;
    });
    const linkDeps = makeLinkDeps();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [makeSub({ lastPushedAt: null })],
      getPreset: () => makePreset({ skipEmpty: false }),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'body',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'UTC',
      now: () => now,
      ...linkDeps,
    });
    await scheduler.runOnce();
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!).toContain(`${linkDeps.publicBaseUrl}/digest/share/42?sig=`);

    const urlMatch = capturedBody!.match(/https?:\/\/\S+/);
    expect(urlMatch).not.toBeNull();
    const sigParam = new URL(urlMatch![0]).searchParams.get('sig');
    expect(sigParam).not.toBeNull();
    const verified = verifyShareSig({
      digestId: 42,
      sigParam: sigParam!,
      signingKey: linkDeps.signingKey,
    });
    expect(verified.ok).toBe(true);
  });

  it('pushes when now >= today_at(push_time) AND last_pushed_at < today_at(push_time)', async () => {
    const sendOutbound = vi.fn(async () => {});
    const markPushed = vi.fn();
    const saveReport = vi.fn();
    const subscriptions = [
      makeSub({
        lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime(),
      }),
    ];
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => subscriptions,
      getPreset: () => makePreset({ skipEmpty: true }),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'digest body',
      sendOutbound,
      markPushed,
      saveReport,
      getTimezone: () => 'UTC',
      now: () => now,
      ...makeLinkDeps(),
    });
    await scheduler.runOnce();
    expect(sendOutbound).toHaveBeenCalled();
    expect(markPushed).toHaveBeenCalledWith(1, expect.any(Number));
  });

  it('persists every generated snapshot via saveReport, even when skipEmpty skips delivery (P0-1)', async () => {
    const sendOutbound = vi.fn();
    const markPushed = vi.fn();
    const saveReport = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [makeSub({ lastPushedAt: null })],
      getPreset: () => makePreset({ skipEmpty: true }),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => true,
      renderIM: () => '',
      sendOutbound,
      markPushed,
      saveReport,
      getTimezone: () => 'UTC',
      now: () => now,
    });
    await scheduler.runOnce();
    // Skipped delivery but still persisted.
    expect(sendOutbound).not.toHaveBeenCalled();
    expect(saveReport).toHaveBeenCalledTimes(1);
    expect(saveReport.mock.calls[0][0]).toBe('telegram');
  });

  it('persists snapshots for active pushes as well (P0-1)', async () => {
    const sendOutbound = vi.fn(async () => {});
    const saveReport = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset({ skipEmpty: false }),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport,
      getTimezone: () => 'UTC',
      now: () => now,
      ...makeLinkDeps(),
    });
    await scheduler.runOnce();
    expect(sendOutbound).toHaveBeenCalledTimes(1);
    expect(saveReport).toHaveBeenCalledTimes(1);
    expect(saveReport.mock.calls[0][0]).toBe('telegram');
  });

  it('skips paused subscriptions', async () => {
    const sendOutbound = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [makeSub({ paused: true })],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'UTC',
      now: () => now,
    });
    await scheduler.runOnce();
    expect(sendOutbound).not.toHaveBeenCalled();
  });

  it('skips generation entirely when the outbound channel is not running', async () => {
    const generate = vi.fn(async () => ({
      snapshot: dummySnapshot(),
      status: 'complete' as const,
    }));
    const sendOutbound = vi.fn();
    const saveReport = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [makeSub()],
      getPreset: () => makePreset(),
      generate,
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport,
      canSendChannel: () => false,
      getTimezone: () => 'UTC',
      now: () => now,
    });
    await scheduler.runOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(sendOutbound).not.toHaveBeenCalled();
    expect(saveReport).not.toHaveBeenCalled();
  });

  it('treats partial snapshots as failures and does not send or mark them pushed', async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof createPushScheduler>[0]['logger'];
    const sendOutbound = vi.fn();
    const markPushed = vi.fn();
    const saveReport = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [makeSub()],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'partial' as const }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed,
      saveReport,
      logger,
      getTimezone: () => 'UTC',
      now: () => now,
    });
    await scheduler.runOnce();
    expect(sendOutbound).not.toHaveBeenCalled();
    expect(markPushed).not.toHaveBeenCalled();
    expect(saveReport).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1]?.error ?? '')).toMatch(/DIGEST_PARTIAL_RESULT/);
  });

  it('does NOT push twice in the same day (last_pushed_at >= today_at(push_time))', async () => {
    const sendOutbound = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ lastPushedAt: new Date('2026-04-18T09:00:30Z').getTime() }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'UTC',
      now: () => now,
    });
    await scheduler.runOnce();
    expect(sendOutbound).not.toHaveBeenCalled();
  });

  it('logs per-subscription errors via logger.warn instead of swallowing (P1-6)', async () => {
    // Per-subscription try/catch: a `generate` throw is caught inside the
    // per-sub loop, logged, and `runOnce` resolves normally so later
    // subscriptions in the same tick can still run.
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof createPushScheduler>[0]['logger'];
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset(),
      generate: async () => {
        throw new Error('boom');
      },
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound: vi.fn(),
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      logger,
      getTimezone: () => 'UTC',
      now: () => now,
    });
    await scheduler.runOnce();
    expect(warn).toHaveBeenCalled();
    const [msg, payload] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(String(msg)).toMatch(/push/i);
    expect(payload).toMatchObject({
      error: 'boom',
      subscriptionId: 1,
      channelId: 'telegram',
      presetId: 1,
    });
    expect(typeof payload.date).toBe('string');
  });

  it('suppresses a subscription after 3 consecutive failures to cap retry cost (P1a)', async () => {
    // Without a throttle, a durable break (bad preset / expired auth) burns
    // LLM tokens every tick forever. After PUSH_FAILURE_THRESHOLD=3 consecutive
    // failures the subscription should be skipped for ~1h.
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof createPushScheduler>[0]['logger'];
    const generate = vi.fn(async () => {
      throw new Error('durable failure');
    });
    // Tick 1 lands at 09:01, tick 2 one minute later, etc.
    const clock = { current: new Date('2026-04-18T09:01:00Z') };
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ id: 42, lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset(),
      generate,
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound: vi.fn(),
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      logger,
      getTimezone: () => 'UTC',
      now: () => clock.current,
    });
    // Tick 1–3: all fail, all log with consecutiveFailures=1,2,3.
    for (let i = 0; i < 3; i++) {
      await scheduler.runOnce();
      clock.current = new Date(clock.current.getTime() + 60_000);
    }
    expect(generate).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2][1]).toMatchObject({
      subscriptionId: 42,
      consecutiveFailures: 3,
      // At the threshold tick, suppressUntil is set (non-null number).
    });
    expect(typeof (warn.mock.calls[2][1] as { suppressedUntil: number }).suppressedUntil).toBe(
      'number',
    );

    // Tick 4, still within suppress window: sub should be silently skipped.
    await scheduler.runOnce();
    expect(generate).toHaveBeenCalledTimes(3); // unchanged
    expect(warn).toHaveBeenCalledTimes(3); // no new log

    // Advance 2h past the suppress window: generate is tried again (still
    // fails, count increments).
    clock.current = new Date(clock.current.getTime() + 2 * 60 * 60 * 1000);
    await scheduler.runOnce();
    expect(generate).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('resets the failure counter after a successful push (P1a recovery)', async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof createPushScheduler>[0]['logger'];
    const clock = { current: new Date('2026-04-18T09:01:00Z') };
    let shouldFail = true;
    const generate = vi.fn(async () => {
      if (shouldFail) throw new Error('transient');
      return { snapshot: dummySnapshot(), status: 'complete' as const };
    });
    const markPushed = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ id: 7, lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset(),
      generate,
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound: vi.fn(async () => {}),
      markPushed,
      saveReport: vi.fn(),
      logger,
      getTimezone: () => 'UTC',
      now: () => clock.current,
      ...makeLinkDeps(),
    });
    // 2 failures (below threshold).
    await scheduler.runOnce();
    clock.current = new Date(clock.current.getTime() + 60_000);
    await scheduler.runOnce();
    expect(warn).toHaveBeenCalledTimes(2);
    // Recover: success clears state.
    shouldFail = false;
    // Move past the push boundary next-day so the due rule re-fires.
    clock.current = new Date('2026-04-19T09:01:00Z');
    await scheduler.runOnce();
    expect(markPushed).toHaveBeenCalledTimes(1);
    // Fail again next day: count restarts from 1 (not 3 → immediate suppress).
    shouldFail = true;
    clock.current = new Date('2026-04-20T09:01:00Z');
    await scheduler.runOnce();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2][1]).toMatchObject({ consecutiveFailures: 1, suppressedUntil: null });
  });

  it('does NOT re-push when pushTime is moved later the same day', async () => {
    // Regression lock for the post-merge bug where boundary-based dedupe
    // ("last_pushed_at >= today_at(push_time)") re-fired a subscription
    // whose `push_time` had just moved 09:00 → 10:00: the stored
    // `lastPushedAt = T09:00:05` sits below the new `T10:00` boundary,
    // so the scheduler treated it as due again and sent the same
    // yesterday-UTC digest twice within an hour.
    const sendOutbound = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({
          pushTime: '10:00',
          lastPushedAt: new Date('2026-04-18T09:00:05Z').getTime(),
        }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'UTC',
      now: () => new Date('2026-04-18T10:01:00Z'),
    });
    await scheduler.runOnce();
    expect(sendOutbound).not.toHaveBeenCalled();
  });

  it('DOES push the next day even when a late push crossed UTC midnight', async () => {
    // Regression lock for the calendar-day-dedupe mis-skip: if yesterday's
    // 23:30 push was delayed and landed at 00:05 UTC of the new day, a
    // naive "same UTC date" check would also skip today's 23:30 fire.
    // Content-date dedupe (`yesterdayUtcISO(lastPushedAt) ===
    // yesterdayUtcISO(now)`) correctly distinguishes: yesterday's content
    // (day N-2) vs today's content (day N-1).
    const sendOutbound = vi.fn(async () => {});
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({
          pushTime: '23:30',
          // Delayed delivery of day N-2's digest, landed 00:05 on day N-1.
          lastPushedAt: new Date('2026-04-19T00:05:00Z').getTime(),
        }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'UTC',
      // On day N, content = yesterdayUtcISO(day N) = day N-1 ≠ day N-2.
      now: () => new Date('2026-04-20T23:35:00Z'),
      ...makeLinkDeps(),
    });
    await scheduler.runOnce();
    expect(sendOutbound).toHaveBeenCalledTimes(1);
  });

  it('skips weekly presets on non-pushDay UTC weekdays', async () => {
    // Regression lock for the weekly-as-daily bug: before the fix, the
    // scheduler never consulted `preset.period` / `preset.pushDay`, so a
    // weekly preset sent a one-day digest every day instead of a 7-day
    // digest on its configured weekday.
    const sendOutbound = vi.fn();
    // 2026-04-17 is a Friday (ISO weekday 5); a preset with pushDay=1
    // (Monday) must not fire on Friday.
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ lastPushedAt: new Date('2026-04-10T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset({ period: 'weekly', pushDay: 1 }),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'UTC',
      now: () => new Date('2026-04-17T09:01:00Z'),
    });
    await scheduler.runOnce();
    expect(sendOutbound).not.toHaveBeenCalled();
  });

  it('pushes weekly presets on their configured pushDay (Monday)', async () => {
    const sendOutbound = vi.fn(async () => {});
    // 2026-04-20 is Monday (ISO weekday 1).
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ lastPushedAt: new Date('2026-04-13T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset({ period: 'weekly', pushDay: 1 }),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'UTC',
      now: () => new Date('2026-04-20T09:01:00Z'),
      ...makeLinkDeps(),
    });
    await scheduler.runOnce();
    expect(sendOutbound).toHaveBeenCalledTimes(1);
  });

  it('isolates per-subscription failures so later subs still push (P1-3)', async () => {
    // Regression lock: without per-sub try/catch, a throw from sub #1 bubbles
    // out of `runOnce` and skips sub #2 and later for this tick entirely.
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof createPushScheduler>[0]['logger'];
    const sendOutbound = vi.fn(async () => {});
    const markPushed = vi.fn();
    const saveReport = vi.fn();
    const calls: number[] = [];
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ id: 1, lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime() }),
        makeSub({ id: 2, lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset(),
      generate: async ({ presetId }) => {
        calls.push(presetId ?? 0);
        if (calls.length === 1) throw new Error('only sub 1 is broken');
        return { snapshot: dummySnapshot(), status: 'complete' };
      },
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed,
      saveReport,
      logger,
      getTimezone: () => 'UTC',
      now: () => now,
      ...makeLinkDeps(),
    });
    await scheduler.runOnce();
    // sub 1 failed → exactly one warn, pinned to sub#1's subscriptionId so a
    // future refactor that accidentally swallows sub#1 and warns on sub#2 is
    // caught.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      subscriptionId: 1,
      channelId: 'telegram',
      presetId: 1,
      error: 'only sub 1 is broken',
    });
    // sub 2 proceeded — send + save + mark all fired exactly once
    expect(sendOutbound).toHaveBeenCalledTimes(1);
    expect(saveReport).toHaveBeenCalledTimes(1);
    expect(markPushed).toHaveBeenCalledTimes(1);
    expect(markPushed.mock.calls[0][0]).toBe(2);
  });
});

describe('IM share-link footer', () => {
  const now = new Date('2026-04-18T09:01:00Z');

  it('appends share URL footer when signingKey + publicBaseUrl are set', async () => {
    const sendOutbound = vi.fn(async () => {});
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'digest body',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'UTC',
      now: () => now,
      getReportRowId: () => 42,
      signingKey: 'a'.repeat(32),
      ttlDays: 14,
      publicBaseUrl: 'https://digest.example.com',
    });
    await scheduler.runOnce();
    expect(sendOutbound).toHaveBeenCalledTimes(1);
    const text: string = sendOutbound.mock.calls[0][2].text;
    expect(text).toContain('digest.example.com/digest/share/42?sig=');
    expect(text).toMatch(/📖 (在浏览器查看|View in browser)/);
  });

  it('falls back without footer + logger.error when getReportRowId returns null', async () => {
    const error = vi.fn();
    const logger = {
      warn: vi.fn(),
      error,
      debug: vi.fn(),
    } as unknown as Parameters<typeof createPushScheduler>[0]['logger'];
    const sendOutbound = vi.fn(async () => {});
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'digest body',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      logger,
      getTimezone: () => 'UTC',
      now: () => now,
      getReportRowId: () => null,
      signingKey: 'a'.repeat(32),
      ttlDays: 14,
      publicBaseUrl: 'https://digest.example.com',
    });
    await scheduler.runOnce();
    expect(sendOutbound).toHaveBeenCalledTimes(1);
    const text: string = sendOutbound.mock.calls[0][2].text;
    expect(text).not.toContain('digest.example.com');
    // DB 一致性问题应当 logger.error (区别于配置缺失,后者只 debug + startup warn 一次)。
    expect(error).toHaveBeenCalledWith(
      'digest push: rowId lookup failed after saveReport',
      expect.objectContaining({ digestId: expect.any(Object) }),
    );
  });

  it('falls back without footer when rowId valid but signingKey is missing', async () => {
    const debug = vi.fn();
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
      debug,
    } as unknown as Parameters<typeof createPushScheduler>[0]['logger'];
    const sendOutbound = vi.fn(async () => {});
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'digest body',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      logger,
      getTimezone: () => 'UTC',
      now: () => now,
      getReportRowId: () => 99,
      // 故意不传 signingKey
      ttlDays: 14,
      publicBaseUrl: 'https://digest.example.com',
    });
    await scheduler.runOnce();
    expect(sendOutbound).toHaveBeenCalledTimes(1);
    const text: string = sendOutbound.mock.calls[0][2].text;
    expect(text).toBe('digest body');
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('no share footer'),
      expect.objectContaining({ hasSigningKey: false, hasPublicBaseUrl: true }),
    );
  });

  it('falls back without footer when rowId valid but publicBaseUrl is missing', async () => {
    const sendOutbound = vi.fn(async () => {});
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({ lastPushedAt: new Date('2026-04-17T09:00:00Z').getTime() }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'digest body',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'UTC',
      now: () => now,
      getReportRowId: () => 99,
      signingKey: 'a'.repeat(32),
      ttlDays: 14,
      // 故意不传 publicBaseUrl
    });
    await scheduler.runOnce();
    expect(sendOutbound).toHaveBeenCalledTimes(1);
    expect(sendOutbound.mock.calls[0][2].text).toBe('digest body');
  });
});

describe('timezone-aware push scheduler', () => {
  it('uses local-tz HH:MM as push-time boundary (fires at UTC 01:00 when tz=Asia/Shanghai + pushTime=09:00)', async () => {
    // pushTime '09:00' interpreted in Asia/Shanghai (UTC+8) → UTC 01:00.
    // `now = 2026-05-14T01:00:30Z` is 2026-05-14 09:00:30 Shanghai time, so
    // the boundary has just passed in local-tz and the push should fire.
    const sendOutbound = vi.fn(async () => {});
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({
          pushTime: '09:00',
          // Yesterday's push (Shanghai) — different content date so dedupe
          // doesn't fire.
          lastPushedAt: new Date('2026-05-13T01:00:00Z').getTime(),
        }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'Asia/Shanghai',
      now: () => new Date('2026-05-14T01:00:30Z'),
      ...makeLinkDeps(),
    });
    await scheduler.runOnce();
    expect(sendOutbound).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire at UTC 09:00 when tz=Asia/Shanghai (local 17:00, not 09:00)', async () => {
    // Counter-test for the boundary check: with tz='Asia/Shanghai', a
    // `now` at UTC 09:00 maps to local 17:00 — still well past the 09:00
    // boundary on calendar grounds, but the bug we're guarding against is
    // the old `setUTCHours(9, 0)` semantics, which would compute a UTC 09:00
    // boundary and fire because `now == boundary`. The tz-aware version
    // pushes the boundary to UTC 01:00 (Shanghai 09:00), so a `now` of
    // 2026-05-14T00:30:00Z (Shanghai 08:30 — before 09:00 boundary) must
    // NOT fire.
    const sendOutbound = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({
          pushTime: '09:00',
          lastPushedAt: new Date('2026-05-13T01:00:00Z').getTime(),
        }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'Asia/Shanghai',
      // Shanghai 08:30:00 — before the local 09:00 boundary.
      now: () => new Date('2026-05-14T00:30:00Z'),
    });
    await scheduler.runOnce();
    expect(sendOutbound).not.toHaveBeenCalled();
  });

  it('weekly preset uses localWeekday(now, tz) for pushDay comparison', async () => {
    // 2026-05-17T16:00:00Z = Sunday UTC = Monday in Asia/Shanghai.
    // With tz='Asia/Shanghai' the weekday is 1 (Mon) → matches pushDay=1 → fires.
    // With tz='UTC' the weekday is 7 (Sun) → does NOT match → no fire.
    // (Both runs share the same fixture; tz is the only varying input.)
    const fakeNow = new Date('2026-05-17T16:00:00Z');
    const makeFixture = (tz: string, sendOutbound: ReturnType<typeof vi.fn>) =>
      createPushScheduler({
        listDueSubscriptions: () => [
          makeSub({
            pushTime: '00:00',
            // Push from > 1 week ago so the daily content-date dedupe
            // doesn't interfere.
            lastPushedAt: new Date('2026-05-09T16:00:00Z').getTime(),
          }),
        ],
        getPreset: () => makePreset({ period: 'weekly', pushDay: 1 }),
        generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
        isFullyEmpty: () => false,
        renderIM: () => 'x',
        sendOutbound,
        markPushed: vi.fn(),
        saveReport: vi.fn(),
        getTimezone: () => tz,
        now: () => fakeNow,
        ...makeLinkDeps(),
      });

    const sendOutboundUtc = vi.fn();
    await makeFixture('UTC', sendOutboundUtc).runOnce();
    expect(sendOutboundUtc).not.toHaveBeenCalled();

    const sendOutboundShanghai = vi.fn(async () => {});
    await makeFixture('Asia/Shanghai', sendOutboundShanghai).runOnce();
    expect(sendOutboundShanghai).toHaveBeenCalledTimes(1);
  });

  it('todayAtPushTime correctly handles UTC+14 (Pacific/Kiritimati) — fires at local 09:00', async () => {
    // Regression for the boundary bug: the old `±720` wrap in `todayAtPushTime`
    // wrapped UTC+14 / +13 / +12:45 the wrong way and computed a boundary 24h
    // late, so a push subscribed for 09:00 in Pacific/Kiritimati would never
    // fire on the correct day.
    //
    // Pacific/Kiritimati 09:00 on 2026-05-14 = UTC 19:00 on 2026-05-13.
    // With `now = 2026-05-13T19:00:30Z` (Kiritimati May 14 09:00:30) the
    // correctly-computed boundary has just passed and the push must fire.
    // The buggy impl would place the boundary at 2026-05-14T19:00:00Z (a day
    // later) and silently swallow this tick.
    const sendOutbound = vi.fn(async () => {});
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({
          pushTime: '09:00',
          // Previous content date (Kiritimati May 13 push, content for May 12).
          lastPushedAt: new Date('2026-05-12T19:00:00Z').getTime(),
        }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'Pacific/Kiritimati',
      now: () => new Date('2026-05-13T19:00:30Z'),
      ...makeLinkDeps(),
    });
    await scheduler.runOnce();
    expect(sendOutbound).toHaveBeenCalledTimes(1);
  });

  it('todayAtPushTime correctly handles UTC+14 (Pacific/Kiritimati) — dedupes after delivery the same local day', async () => {
    // Companion to the previous test. After the May-14 09:00 Kiritimati push
    // has landed, a later tick at `now = 2026-05-14T09:00:00Z` (Kiritimati
    // May 14 23:00 — still the SAME local day, content-date still 2026-05-13)
    // must NOT re-fire even though the boundary is well in the past.
    // Catches a hypothetical regression where boundary is moved forward but
    // content-date dedupe loses the live tz.
    const sendOutbound = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({
          pushTime: '09:00',
          // Previous tick already pushed at Kiritimati May 14 09:00:30.
          lastPushedAt: new Date('2026-05-13T19:00:30Z').getTime(),
        }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'Pacific/Kiritimati',
      // Kiritimati May 14 23:00 — same local day as the previous push.
      now: () => new Date('2026-05-14T09:00:00Z'),
    });
    await scheduler.runOnce();
    expect(sendOutbound).not.toHaveBeenCalled();
  });

  it('content-date dedupe uses yesterdayLocalISO with live tz', async () => {
    // `now = 2026-05-14T01:00:30Z` (Shanghai 09:00:30 Wed) → yesterday-local =
    // 2026-05-13. `lastPushedAt = 2026-05-13T16:30:00Z` (Shanghai 00:30 Thu) →
    // yesterday-local = 2026-05-13 → SAME content date → dedupe must skip
    // sendOutbound.
    //
    // The same fixture under tz='UTC' would not dedupe: yesterday-UTC of
    // `now` is 2026-05-13, yesterday-UTC of `lastPushedAt` is 2026-05-12 →
    // different content dates. So if the scheduler ignored tz and used UTC
    // here, sendOutbound would fire — and this test would fail.
    const sendOutbound = vi.fn();
    const scheduler = createPushScheduler({
      listDueSubscriptions: () => [
        makeSub({
          pushTime: '09:00',
          lastPushedAt: new Date('2026-05-13T16:30:00Z').getTime(),
        }),
      ],
      getPreset: () => makePreset(),
      generate: async () => ({ snapshot: dummySnapshot(), status: 'complete' }),
      isFullyEmpty: () => false,
      renderIM: () => 'x',
      sendOutbound,
      markPushed: vi.fn(),
      saveReport: vi.fn(),
      getTimezone: () => 'Asia/Shanghai',
      now: () => new Date('2026-05-14T01:00:30Z'),
    });
    await scheduler.runOnce();
    expect(sendOutbound).not.toHaveBeenCalled();
  });
});
