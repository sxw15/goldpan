// monorepo/packages/im-runtime/tests/runtime.test.ts

import { type HandleInputRepos, SqliteConversationRepository } from '@goldpan/core';
import { type ILogObj, Logger } from 'tslog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageDedupe } from '../src/inbound/dedupe.js';
import { IMRuntime } from '../src/runtime.js';
import type {
  ChannelAdapter,
  ChannelReplyPayload,
  ChannelStartDeps,
  SessionRef,
} from '../src/types.js';
import { createTestDB, type TestDB } from './helpers/test-db.js';

function stubChannel(id: string): ChannelAdapter {
  let started = false;
  return {
    channelId: id,
    capabilities: {
      inlineButtons: false,
      typingIndicator: false,
      richFormat: false,
      maxMessageLength: 4096,
      images: false,
      lifecycleHooks: false,
    },
    defaultFilters: [],
    renderResult: vi.fn(() => ({ text: 'rendered' })),
    renderError: vi.fn(() => ({ text: 'err' })),
    buildSystemReply: vi.fn((text: string) => ({ text })),
    buildHelpReply: vi.fn(() => ({ text: 'help-stub' })),
    buildResetReply: vi.fn(() => ({ text: 'reset-stub' })),
    start: vi.fn(async (deps) => {
      deps.installSendReply(async () => undefined);
      started = true;
    }),
    shutdown: vi.fn(async () => {
      started = false;
    }),
    describe: vi.fn(() => ({
      channelId: id,
      state: started ? ('running' as const) : ('stopped' as const),
      inFlightCount: 0,
    })),
  };
}

function createMinimalDeps(db: ReturnType<typeof createTestDB>['db']) {
  return {
    db,
    callLlm: (() => {}) as never,
    pluginRegistry: {
      getIntentDeclarations: () => [],
      findIntentDeclaration: () => undefined,
      destroyAll: async () => undefined,
      getService: () => undefined,
    } as never,
    config: { language: 'en' } as never,
    repos: {} as HandleInputRepos,
    conversationRepo: new SqliteConversationRepository(db),
    logger: new Logger<ILogObj>({ type: 'hidden' }),
  };
}

describe('IMRuntime', () => {
  let testDb: TestDB;
  afterEach(() => testDb?.cleanup());

  it('start invokes channel.start; shutdown invokes channel.shutdown', async () => {
    testDb = createTestDB();
    const ch = stubChannel('mock');
    const rt = new IMRuntime(createMinimalDeps(testDb.db));
    rt.register(ch);
    await rt.start();
    expect(ch.start).toHaveBeenCalledTimes(1);
    expect(rt.describeChannels()[0].state).toBe('running');
    await rt.shutdown();
    expect(ch.shutdown).toHaveBeenCalledTimes(1);
  });

  it('describeChannels returns all registered channels (stopped before start)', async () => {
    testDb = createTestDB();
    const rt = new IMRuntime(createMinimalDeps(testDb.db));
    rt.register(stubChannel('a'));
    rt.register(stubChannel('b'));
    const descriptors = rt.describeChannels();
    expect(descriptors.map((d) => d.channelId).sort()).toEqual(['a', 'b']);
    expect(descriptors.every((d) => d.state === 'stopped')).toBe(true);
  });

  it('per-channel routingMode override is accepted', async () => {
    testDb = createTestDB();
    const rt = new IMRuntime(createMinimalDeps(testDb.db), { routingMode: 'per_chat' });
    rt.register(stubChannel('mock'), { routingMode: 'per_user' });
    await rt.start();
    expect(rt.describeChannels()[0].state).toBe('running');
    await rt.shutdown();
  });

  it('runs the dedupe purge timer after start and stops it on shutdown', async () => {
    vi.useFakeTimers();
    try {
      testDb = createTestDB();
      const dedupe = new MessageDedupe(testDb.db);

      const oldDate = new Date('2020-01-01T00:00:00Z');
      const recentDate = new Date(Date.now() - 60_000);
      // Insert one stale row + one fresh row directly via dedupe.markIfNew so we use the
      // real insert path; then back-date the stale row's seen_at.
      dedupe.markIfNew({ channelId: 'tg', accountId: 'b', chatId: 'c1', platformMsgId: 'old' });
      dedupe.markIfNew({ channelId: 'tg', accountId: 'b', chatId: 'c1', platformMsgId: 'new' });
      // Backdate via raw SQL to INTEGER epoch ms — matches the column type exactly.
      const raw = (testDb.db as unknown as { $client: { exec: (sql: string) => void } }).$client;
      raw.exec(
        `UPDATE im_messages_seen SET seen_at = ${oldDate.getTime()} WHERE platform_msg_id = 'old';`,
      );
      raw.exec(
        `UPDATE im_messages_seen SET seen_at = ${recentDate.getTime()} WHERE platform_msg_id = 'new';`,
      );

      const rt = new IMRuntime(createMinimalDeps(testDb.db), {
        dedupeTtlHours: 1,
        dedupePurgeIntervalMinutes: 1,
      });
      rt.register(stubChannel('mock'));
      await rt.start();

      // Advance past the first scheduled tick.
      await vi.advanceTimersByTimeAsync(60_000 + 100);

      // Stale row removed; fresh row preserved.
      const stillNew = dedupe.markIfNew({
        channelId: 'tg',
        accountId: 'b',
        chatId: 'c1',
        platformMsgId: 'new',
      });
      expect(stillNew).toBe(false);
      const oldGone = dedupe.markIfNew({
        channelId: 'tg',
        accountId: 'b',
        chatId: 'c1',
        platformMsgId: 'old',
      });
      expect(oldGone).toBe(true);

      await rt.shutdown();
      // After shutdown the timer must be cleared — advancing time should not trigger
      // any further work (no errors, no further deletes).
      await vi.advanceTimersByTimeAsync(120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables the dedupe purge timer when interval=0', async () => {
    vi.useFakeTimers();
    try {
      testDb = createTestDB();
      const dedupe = new MessageDedupe(testDb.db);
      dedupe.markIfNew({ channelId: 'tg', accountId: 'b', chatId: 'c1', platformMsgId: 'x' });
      const raw = (testDb.db as unknown as { $client: { exec: (sql: string) => void } }).$client;
      raw.exec(
        `UPDATE im_messages_seen SET seen_at = ${Date.UTC(2020, 0, 1, 0, 0, 0)} WHERE platform_msg_id = 'x';`,
      );

      const rt = new IMRuntime(createMinimalDeps(testDb.db), {
        dedupeTtlHours: 1,
        dedupePurgeIntervalMinutes: 0,
      });
      rt.register(stubChannel('mock'));
      await rt.start();
      await vi.advanceTimersByTimeAsync(120_000);

      // Stale row must STILL be present because the timer never fired.
      const reMarked = dedupe.markIfNew({
        channelId: 'tg',
        accountId: 'b',
        chatId: 'c1',
        platformMsgId: 'x',
      });
      expect(reMarked).toBe(false);

      await rt.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() keeps already-started channels running if a later channel fails', async () => {
    testDb = createTestDB();
    const okChannel = stubChannel('a');
    const badChannel = stubChannel('b');
    badChannel.start = vi.fn(async () => {
      throw new Error('boom: bad token');
    });
    const rt = new IMRuntime(createMinimalDeps(testDb.db));
    rt.register(okChannel);
    rt.register(badChannel);
    await expect(rt.start()).rejects.toThrow('boom: bad token');
    // Healthy channels stay up so callers can degrade to partial IM availability.
    expect(okChannel.shutdown).not.toHaveBeenCalled();
    // Channel B gets a best-effort cleanup too, because adapters may have partially
    // initialized transport state before throwing from start().
    expect(badChannel.shutdown).toHaveBeenCalledTimes(1);
    const descriptors = rt.describeChannels();
    expect(descriptors.find((d) => d.channelId === 'a')?.state).toBe('running');
    expect(descriptors.find((d) => d.channelId === 'b')?.state).toBe('error');
  });

  it('cleans up a channel that throws after partially initializing during start()', async () => {
    testDb = createTestDB();
    const halfStarted = stubChannel('half');
    halfStarted.start = vi.fn(async (deps) => {
      deps.installSendReply(async () => undefined);
      throw new Error('boom after partial init');
    });

    const rt = new IMRuntime(createMinimalDeps(testDb.db));
    rt.register(halfStarted);

    await expect(rt.start()).rejects.toThrow('boom after partial init');
    expect(halfStarted.shutdown).toHaveBeenCalledTimes(1);
  });

  it('describeChannels exposes failed channels with lastErrorMessage after a failed start()', async () => {
    testDb = createTestDB();
    const okChannel = stubChannel('a');
    const badChannel = stubChannel('b');
    badChannel.start = vi.fn(async () => {
      throw new Error('boom: bad token');
    });
    const rt = new IMRuntime(createMinimalDeps(testDb.db));
    rt.register(okChannel);
    rt.register(badChannel);

    await expect(rt.start()).rejects.toThrow('boom: bad token');

    const descriptors = rt.describeChannels();
    const aDesc = descriptors.find((d) => d.channelId === 'a');
    const bDesc = descriptors.find((d) => d.channelId === 'b');
    expect(aDesc?.state).toBe('running');
    expect(bDesc?.state).toBe('error');
    expect(bDesc?.lastErrorMessage).toBe('boom: bad token');
    expect(bDesc?.lastErrorAt).toBeInstanceOf(Date);
  });

  it('shutdown() after a partial failed start() stops only the still-running channels once', async () => {
    testDb = createTestDB();
    const okChannel = stubChannel('a');
    const badChannel = stubChannel('b');
    badChannel.start = vi.fn(async () => {
      throw new Error('boom');
    });
    const rt = new IMRuntime(createMinimalDeps(testDb.db));
    rt.register(okChannel);
    rt.register(badChannel);

    await expect(rt.start()).rejects.toThrow('boom');
    // okChannel remains live after the failed start; badChannel was shut down by startChannel's catch.
    expect(okChannel.shutdown).toHaveBeenCalledTimes(0);
    expect(badChannel.shutdown).toHaveBeenCalledTimes(1);

    // Subsequent shutdown() must stop the healthy channel exactly once, while the failed
    // channel stays at its prior cleanup count.
    await rt.shutdown();
    expect(okChannel.shutdown).toHaveBeenCalledTimes(1);
    expect(badChannel.shutdown).toHaveBeenCalledTimes(1);
  });

  it('describeChannels reflects adapter-reported runtime errors after startup', async () => {
    testDb = createTestDB();
    let state: 'running' | 'error' = 'running';
    const channel = stubChannel('mock');
    channel.describe = vi.fn(() => ({
      channelId: 'mock',
      state,
      inFlightCount: 0,
    }));

    const rt = new IMRuntime(createMinimalDeps(testDb.db));
    rt.register(channel);
    await rt.start();
    expect(rt.describeChannels()[0].state).toBe('running');

    state = 'error';
    expect(rt.describeChannels()[0].state).toBe('error');

    await rt.shutdown();
  });
});

describe('IMRuntime.sendOutbound', () => {
  let testDb: TestDB;
  afterEach(() => testDb?.cleanup());

  function captureSendChannel(id: string) {
    const sent: Array<{ ref: SessionRef; payload: ChannelReplyPayload }> = [];
    const lifecycleLog: Array<{ origin: 'inbound' | 'outbound'; isFinal: boolean }> = [];
    const adapter: ChannelAdapter = {
      channelId: id,
      capabilities: {
        inlineButtons: false,
        typingIndicator: false,
        richFormat: false,
        maxMessageLength: 4096,
        images: false,
        lifecycleHooks: true,
      },
      defaultFilters: [],
      lifecycle: {
        onSendReply: (ctx) => {
          lifecycleLog.push({ origin: ctx.origin, isFinal: ctx.isFinal });
        },
      },
      renderResult: vi.fn((result) => [{ text: `R:${(result as { text?: string }).text ?? ''}` }]),
      renderError: vi.fn(() => ({ text: 'err' })),
      buildSystemReply: vi.fn((text: string) => ({ text })),
      buildHelpReply: vi.fn(() => ({ text: 'help-stub' })),
      buildResetReply: vi.fn(() => ({ text: 'reset-stub' })),
      start: vi.fn(async (deps: ChannelStartDeps) => {
        deps.installSendReply(async (ref, payload) => {
          sent.push({ ref, payload });
        });
      }),
      shutdown: vi.fn(async () => undefined),
      describe: vi.fn(() => ({ channelId: id, state: 'running' as const, inFlightCount: 0 })),
    };
    return { adapter, sent, lifecycleLog };
  }

  it('renders a content result via the target channel and invokes installSendReply', async () => {
    testDb = createTestDB();
    const { adapter, sent } = captureSendChannel('telegram');
    const rt = new IMRuntime(createMinimalDeps(testDb.db));
    rt.register(adapter);
    await rt.start();

    await rt.sendOutbound(
      'telegram',
      { channelId: 'telegram', accountId: 'a1', chatId: 'c1', userId: 'u1' },
      { type: 'content', text: 'hi' },
    );

    expect(sent).toHaveLength(1);
    expect((sent[0].payload as { text: string }).text).toBe('R:hi');
    expect(sent[0].ref.chatId).toBe('c1');
    await rt.shutdown();
  });

  it('throws CHANNEL_NOT_FOUND when the channelId is not registered', async () => {
    testDb = createTestDB();
    const rt = new IMRuntime(createMinimalDeps(testDb.db));
    rt.register(stubChannel('telegram'));
    await rt.start();
    await expect(
      rt.sendOutbound(
        'slack',
        { channelId: 'slack', accountId: 'a', chatId: 'c', userId: 'u' },
        { type: 'content', text: 'x' },
      ),
    ).rejects.toThrow(/CHANNEL_NOT_FOUND/);
    await rt.shutdown();
  });

  it('marks the lifecycle hook context with origin="outbound"', async () => {
    testDb = createTestDB();
    const { adapter, lifecycleLog } = captureSendChannel('telegram');
    const rt = new IMRuntime(createMinimalDeps(testDb.db));
    rt.register(adapter);
    await rt.start();
    await rt.sendOutbound(
      'telegram',
      { channelId: 'telegram', accountId: 'a', chatId: 'c', userId: 'u' },
      { type: 'content', text: 'x' },
    );
    expect(lifecycleLog).toEqual([{ origin: 'outbound', isFinal: true }]);
    await rt.shutdown();
  });
});
