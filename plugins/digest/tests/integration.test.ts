import { initI18n, resetI18n } from '@goldpan/core/i18n';
import type { PluginRegistry } from '@goldpan/core/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDigestTables } from '../src/db.js';
import { goldpanPlugin } from '../src/index.js';
import { yesterdayLocalISO } from '../src/render/helpers.js';
import { makeTestPluginContext } from './fixtures/plugin-context.js';
import { makeTestDbWithMetadata, seedDigestFixture } from './fixtures/seed.js';

// Minimal mock: digest_query without includeAiSummary skips the LLM entirely,
// but initialize() still requires a callLlm capability when enabled.
const mockCallLlm = vi.fn(async () => ({
  headline: 'ok',
  bullets: ['a'],
  closing: '',
}));

function fakeRegistry(): PluginRegistry {
  const services = new Map<string, unknown>();
  return {
    registerService: (name: string, svc: unknown) => services.set(name, svc),
    getService: (name: string) => services.get(name),
  } as unknown as PluginRegistry;
}

describe('digest plugin integration', () => {
  beforeEach(() => {
    resetI18n();
    initI18n('en');
  });

  it('initialize → execute(digest_query) returns markdown content', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    try {
      // Seed data before initialize so the fixture tables exist when
      // the engine later queries them via getSnapshot+range. The test
      // fixture's configStore defaults to `timezone: 'UTC'` (see
      // `createMutableTestConfigStore`), matching the plugin's own
      // `getTimezone()` source so the seeded date lines up with whatever
      // the plugin computes at execute time.
      const date = yesterdayLocalISO(new Date(), 'UTC');
      seedDigestFixture(db, { dateISO: date, captures: 1, findings: 1 });
      const pluginRegistry = fakeRegistry();
      await goldpanPlugin.initialize?.(makeTestPluginContext().context, {
        db,
        pluginRegistry,
        callLlm: mockCallLlm,
        config: { digest: { enabled: true } },
      } as any);
      const result = await goldpanPlugin.execute('digest_query', '', { language: 'en' } as any);
      expect(result.type).toBe('content');
      expect((result as { text: string }).text).toMatch(/digest/i);
    } finally {
      await goldpanPlugin.destroy?.();
      cleanup();
    }
  });

  it('returns plugin_disabled content when DIGEST_ENABLED=false', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    try {
      ensureDigestTables(db);
      const pluginRegistry = fakeRegistry();
      await goldpanPlugin.initialize?.(makeTestPluginContext({ enabled: false }).context, {
        db,
        pluginRegistry,
        config: { digest: { enabled: false } },
      } as any);
      const result = await goldpanPlugin.execute('digest_query', '', { language: 'en' } as any);
      expect(result.type).toBe('content');
      expect((result as { text: string }).text).toMatch(/disabled|未启用/);
    } finally {
      await goldpanPlugin.destroy?.();
      cleanup();
    }
  });

  // Regression test for P1-2: under `per_chat` routing, `sessionKey` is only 3
  // segments (channel:account:chat) and does NOT carry the real userId. If the
  // plugin reverse-engineers a userId by falling back to `chatId`, every user
  // in a group chat subscribes to the SAME (channelId, accountId, chatId, userId)
  // row and the UNIQUE index collides to a single shared subscription. The fix
  // is to let the IM runtime's inbound dispatcher carry the full SessionRef
  // through `IntentExecutionContext.sessionRef`; the plugin must prefer that
  // over parsing `sessionKey`.
  it('digest_action prefers ctx.sessionRef (per-chat group chat: userId != chatId)', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    try {
      const pluginRegistry = fakeRegistry();
      await goldpanPlugin.initialize?.(makeTestPluginContext().context, {
        db,
        pluginRegistry,
        callLlm: mockCallLlm,
        config: { digest: { enabled: true } },
      } as any);
      const service = (pluginRegistry as any).getService('digest') as {
        listSubscriptions(
          filter?: Record<string, string>,
        ): Array<{ userId: string; chatId: string; channelId: string }>;
      };

      // Two group-chat users share the same (channelId, accountId, chatId)
      // sessionKey under `per_chat` routing. If the plugin fell back to
      // `parseSessionKey(sessionKey)` it would see `userId = chatId` for both
      // users and the second subscribe would no-op against the existing row.
      const sessionKey = 'telegram:botA:groupChatXYZ';
      const ctxBase = {
        language: 'en',
        conversation: { sessionKey, channelId: 'telegram' },
      } as any;

      // Use the "subscribe" fast-path… actually parseDigestAction only
      // fast-paths `list`, so drive through mocked LLM responses.
      const llmMock = mockCallLlm as unknown as ReturnType<typeof vi.fn>;
      llmMock.mockImplementation(async (opts: { step: string }) => {
        if (opts.step === 'digest_action_parser') {
          return { kind: 'subscribe', presetName: 'daily_default', pushTime: '09:00' };
        }
        return { headline: 'ok', bullets: ['a'], closing: '' };
      });

      await goldpanPlugin.execute('digest_action', 'subscribe daily_default 09:00', {
        ...ctxBase,
        sessionRef: {
          channelId: 'telegram',
          accountId: 'botA',
          chatId: 'groupChatXYZ',
          userId: 'userAlice',
        },
      });
      await goldpanPlugin.execute('digest_action', 'subscribe daily_default 09:00', {
        ...ctxBase,
        sessionRef: {
          channelId: 'telegram',
          accountId: 'botA',
          chatId: 'groupChatXYZ',
          userId: 'userBob',
        },
      });

      const subs = service.listSubscriptions({
        channelId: 'telegram',
        accountId: 'botA',
        chatId: 'groupChatXYZ',
      });
      // Two distinct rows — one per real user. If the plugin had fallen back
      // to parsing sessionKey both would have collapsed to userId == chatId.
      const userIds = subs.map((s) => s.userId).sort();
      expect(userIds).toEqual(['userAlice', 'userBob']);
      expect(userIds).not.toContain('groupChatXYZ');
    } finally {
      await goldpanPlugin.destroy?.();
      cleanup();
    }
  });

  it('digest_action throws on 3-segment per_chat sessionKey without ctx.sessionRef (P1-6)', async () => {
    // When the dispatcher ran under `per_chat` routing but failed to set
    // `sessionRef` on the context, the plugin previously invented
    // `userId = chatId` via `parseSessionKey` — silently collapsing every
    // group-chat user onto the same subscription row. The fix is to refuse
    // ambiguous keys loudly so the missing-sessionRef wiring fails fast.
    const { db, cleanup } = makeTestDbWithMetadata();
    try {
      const pluginRegistry = fakeRegistry();
      await goldpanPlugin.initialize?.(makeTestPluginContext().context, {
        db,
        pluginRegistry,
        callLlm: mockCallLlm,
        config: { digest: { enabled: true } },
      } as any);
      const llmMock = mockCallLlm as unknown as ReturnType<typeof vi.fn>;
      llmMock.mockImplementation(async () => ({
        kind: 'subscribe',
        presetName: 'daily_default',
        pushTime: '09:00',
      }));
      await expect(
        goldpanPlugin.execute('digest_action', 'subscribe daily_default 09:00', {
          language: 'en',
          conversation: { sessionKey: 'telegram:botA:groupChatXYZ', channelId: 'telegram' },
        } as any),
      ).rejects.toThrow(/sessionRef|sessionKey/i);
    } finally {
      await goldpanPlugin.destroy?.();
      cleanup();
    }
  });

  it('digest_action falls back to parseSessionKey when ctx.sessionRef is absent (legacy ctx)', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    try {
      const pluginRegistry = fakeRegistry();
      await goldpanPlugin.initialize?.(makeTestPluginContext().context, {
        db,
        pluginRegistry,
        callLlm: mockCallLlm,
        config: { digest: { enabled: true } },
      } as any);
      const service = (pluginRegistry as any).getService('digest') as {
        listSubscriptions(
          filter?: Record<string, string>,
        ): Array<{ userId: string; chatId: string; channelId: string }>;
      };

      const llmMock = mockCallLlm as unknown as ReturnType<typeof vi.fn>;
      llmMock.mockImplementation(async (opts: { step: string }) => {
        if (opts.step === 'digest_action_parser') {
          return { kind: 'subscribe', presetName: 'daily_default', pushTime: '09:00' };
        }
        return { headline: 'ok', bullets: ['a'], closing: '' };
      });

      // Legacy per_user 4-segment key — parseSessionKey gives the correct userId.
      await goldpanPlugin.execute('digest_action', 'subscribe daily_default 09:00', {
        language: 'en',
        conversation: { sessionKey: 'telegram:botA:groupChatXYZ:userCarol', channelId: 'telegram' },
      } as any);

      const subs = service.listSubscriptions({ channelId: 'telegram', accountId: 'botA' });
      expect(subs.map((s) => s.userId)).toEqual(['userCarol']);
    } finally {
      await goldpanPlugin.destroy?.();
      cleanup();
    }
  });
});
