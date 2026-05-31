import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageDedupe } from '../../src/inbound/dedupe.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

describe('MessageDedupe', () => {
  let testDb: TestDB;
  let dedupe: MessageDedupe;

  beforeEach(() => {
    testDb = createTestDB();
    dedupe = new MessageDedupe(testDb.db);
  });
  afterEach(() => testDb.cleanup());

  it('first call returns true (recorded), second returns false', () => {
    const k = { channelId: 'tg', accountId: 'bot1', chatId: 'chat-1', platformMsgId: 'm1' };
    expect(dedupe.markIfNew(k)).toBe(true);
    expect(dedupe.markIfNew(k)).toBe(false);
  });

  it('different platformMsgIds do not collide', () => {
    expect(
      dedupe.markIfNew({
        channelId: 'tg',
        accountId: 'bot1',
        chatId: 'chat-1',
        platformMsgId: 'a',
      }),
    ).toBe(true);
    expect(
      dedupe.markIfNew({
        channelId: 'tg',
        accountId: 'bot1',
        chatId: 'chat-1',
        platformMsgId: 'b',
      }),
    ).toBe(true);
  });

  it('different channels with same platformMsgId do not collide', () => {
    expect(
      dedupe.markIfNew({
        channelId: 'tg',
        accountId: 'bot1',
        chatId: 'chat-1',
        platformMsgId: 'm1',
      }),
    ).toBe(true);
    expect(
      dedupe.markIfNew({
        channelId: 'sl',
        accountId: 'bot1',
        chatId: 'chat-1',
        platformMsgId: 'm1',
      }),
    ).toBe(true);
  });

  it('same channel/account/platformMsgId in different chats do not collide', () => {
    expect(
      dedupe.markIfNew({
        channelId: 'tg',
        accountId: 'bot1',
        chatId: 'chat-1',
        platformMsgId: 'm1',
      }),
    ).toBe(true);
    expect(
      dedupe.markIfNew({
        channelId: 'tg',
        accountId: 'bot1',
        chatId: 'chat-2',
        platformMsgId: 'm1',
      }),
    ).toBe(true);
  });

  it('purgeBefore deletes only old rows', () => {
    dedupe.markIfNew({
      channelId: 'tg',
      accountId: 'bot1',
      chatId: 'chat-1',
      platformMsgId: 'old',
    });
    const future = new Date(Date.now() + 60_000);
    expect(dedupe.purgeBefore(future)).toBe(1);
    // After purge, the same id is treated as new again
    expect(
      dedupe.markIfNew({
        channelId: 'tg',
        accountId: 'bot1',
        chatId: 'chat-1',
        platformMsgId: 'old',
      }),
    ).toBe(true);
  });

  // Regression: purgeBefore compares INTEGER epoch ms; this suite back-dates
  // rows directly via raw SQL so we exercise the comparison path independently
  // of `markIfNew`'s default-clock value, including the boundary case.
  describe('purgeBefore against canonical INTEGER timestamps', () => {
    function backdate(platformMsgId: string, ms: number): void {
      const raw = (testDb.db as unknown as { $client: { exec: (sql: string) => void } }).$client;
      raw.exec(
        `UPDATE im_messages_seen SET seen_at = ${ms} WHERE platform_msg_id = '${platformMsgId}';`,
      );
    }

    it('deletes rows older than the threshold across the seconds boundary', () => {
      dedupe.markIfNew({ channelId: 'tg', accountId: 'b', chatId: 'c', platformMsgId: 'a' });
      dedupe.markIfNew({ channelId: 'tg', accountId: 'b', chatId: 'c', platformMsgId: 'b' });
      dedupe.markIfNew({ channelId: 'tg', accountId: 'b', chatId: 'c', platformMsgId: 'c' });

      backdate('a', Date.UTC(2026, 3, 1, 0, 0, 0));
      backdate('b', Date.UTC(2026, 3, 1, 12, 0, 0));
      backdate('c', Date.UTC(2026, 3, 1, 23, 59, 59));

      // Threshold mid-day on the same date.
      const removed = dedupe.purgeBefore(new Date('2026-04-01T13:00:00Z'));
      expect(removed).toBe(2);

      // Surviving row is the late one.
      expect(
        dedupe.markIfNew({ channelId: 'tg', accountId: 'b', chatId: 'c', platformMsgId: 'c' }),
      ).toBe(false);
      expect(
        dedupe.markIfNew({ channelId: 'tg', accountId: 'b', chatId: 'c', platformMsgId: 'a' }),
      ).toBe(true);
    });

    it('treats threshold as exclusive (rows at exactly the threshold survive)', () => {
      dedupe.markIfNew({ channelId: 'tg', accountId: 'b', chatId: 'c', platformMsgId: 'edge' });
      backdate('edge', Date.UTC(2026, 3, 1, 12, 0, 0));

      // Threshold === stored timestamp → row must NOT be deleted (`<` semantics).
      const removed = dedupe.purgeBefore(new Date('2026-04-01T12:00:00Z'));
      expect(removed).toBe(0);
    });

    it('returns 0 when no rows are older than the threshold', () => {
      dedupe.markIfNew({ channelId: 'tg', accountId: 'b', chatId: 'c', platformMsgId: 'fresh' });
      // Far in the past → nothing to purge.
      expect(dedupe.purgeBefore(new Date('2000-01-01T00:00:00Z'))).toBe(0);
    });
  });

  // Regression: the previous catch-block matched both SQLITE_CONSTRAINT_UNIQUE
  // and the parent SQLITE_CONSTRAINT, so a NOT NULL / CHECK / FK violation
  // would be silently swallowed as "we've seen it" — masking real schema-level
  // bugs. The filter must now ONLY swallow UNIQUE violations and rethrow
  // everything else.
  describe('error code discrimination', () => {
    it('rethrows non-UNIQUE constraint errors instead of treating them as "seen"', () => {
      const fakeDb = {
        insert: () => ({
          values: () => ({
            run: () => {
              const err = new Error(
                'NOT NULL constraint failed: im_messages_seen.chat_id',
              ) as Error & {
                code?: string;
              };
              err.code = 'SQLITE_CONSTRAINT_NOTNULL';
              throw err;
            },
          }),
        }),
      } as never;
      const d = new MessageDedupe(fakeDb);
      expect(() =>
        d.markIfNew({
          channelId: 'tg',
          accountId: 'bot',
          chatId: 'c',
          platformMsgId: 'm',
        }),
      ).toThrow(/NOT NULL/);
    });

    it('rethrows the bare parent SQLITE_CONSTRAINT (no UNIQUE suffix) too', () => {
      const fakeDb = {
        insert: () => ({
          values: () => ({
            run: () => {
              const err = new Error('CHECK constraint failed') as Error & { code?: string };
              err.code = 'SQLITE_CONSTRAINT';
              throw err;
            },
          }),
        }),
      } as never;
      const d = new MessageDedupe(fakeDb);
      expect(() =>
        d.markIfNew({
          channelId: 'tg',
          accountId: 'bot',
          chatId: 'c',
          platformMsgId: 'm',
        }),
      ).toThrow(/CHECK/);
    });

    it('still swallows SQLITE_CONSTRAINT_UNIQUE and reports "not new"', () => {
      const fakeDb = {
        insert: () => ({
          values: () => ({
            run: () => {
              const err = new Error('UNIQUE constraint failed') as Error & { code?: string };
              err.code = 'SQLITE_CONSTRAINT_UNIQUE';
              throw err;
            },
          }),
        }),
      } as never;
      const d = new MessageDedupe(fakeDb);
      expect(
        d.markIfNew({
          channelId: 'tg',
          accountId: 'bot',
          chatId: 'c',
          platformMsgId: 'm',
        }),
      ).toBe(false);
    });
  });
});
