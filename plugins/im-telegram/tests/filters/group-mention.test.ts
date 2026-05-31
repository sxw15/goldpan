import type { InboundMessage } from '@goldpan/im-runtime';
import { describe, expect, it } from 'vitest';
import { TelegramGroupMentionFilter } from '../../src/filters/group-mention.js';

const dm = (text: string): InboundMessage => ({
  channelId: 'telegram',
  accountId: 'bot',
  chatId: '1',
  userId: 'u',
  platformMsgId: 'm',
  text,
  contentType: 'text',
  raw: { message: { chat: { type: 'private' }, text } },
  receivedAt: new Date(),
});

const group = (text: string, opts: { reply_to_self?: boolean } = {}): InboundMessage => ({
  channelId: 'telegram',
  accountId: 'bot',
  chatId: '-100',
  userId: 'u',
  platformMsgId: 'm',
  text,
  contentType: 'text',
  raw: {
    message: {
      chat: { type: 'group' },
      text,
      ...(opts.reply_to_self
        ? { reply_to_message: { from: { username: 'mybot', is_bot: true } } }
        : {}),
    },
  },
  receivedAt: new Date(),
});

describe('TelegramGroupMentionFilter', () => {
  const f = new TelegramGroupMentionFilter({ botUsername: 'mybot' });

  it('passes DMs unconditionally', () => {
    expect(f.shouldHandle(dm('hello'))).toEqual({ type: 'pass' });
  });

  it('rejects group messages without mention/command/reply', () => {
    expect(f.shouldHandle(group('plain chatter'))).toEqual({ type: 'reject' });
  });

  it('passes group messages starting with a slash command', () => {
    expect(f.shouldHandle(group('/ask hi'))).toEqual({ type: 'pass' });
  });

  it('passes group messages containing @bot mention', () => {
    expect(f.shouldHandle(group('hey @mybot what?'))).toEqual({ type: 'pass' });
  });

  it('passes group messages that are replies to the bot', () => {
    expect(f.shouldHandle(group('thanks', { reply_to_self: true }))).toEqual({ type: 'pass' });
  });

  it('mention check is case-insensitive', () => {
    expect(f.shouldHandle(group('hi @MyBot ?'))).toEqual({ type: 'pass' });
  });

  // Word-boundary regression coverage — the previous implementation used
  // `text.includes('@mybot')` which would mis-match any longer username
  // beginning with `mybot` (e.g. `@mybot_x`, `@mybotanyrocks`). Telegram
  // usernames are globally unique, so a real `@mybotanyrocks` is a different
  // bot/user — addressing it must not pass through this filter as a mention
  // of `@mybot`.
  it('does NOT match when the username has a longer suffix (e.g. @mybot_x)', () => {
    expect(f.shouldHandle(group('hi @mybot_x what?'))).toEqual({ type: 'reject' });
    expect(f.shouldHandle(group('see @mybotanyrocks too'))).toEqual({ type: 'reject' });
  });

  it('matches when the mention is at the very start of the message', () => {
    expect(f.shouldHandle(group('@mybot please help'))).toEqual({ type: 'pass' });
  });

  it('matches when the mention is at the very end of the message', () => {
    expect(f.shouldHandle(group('please help @mybot'))).toEqual({ type: 'pass' });
  });

  it('matches when the mention is followed by punctuation (comma, period, etc.)', () => {
    expect(f.shouldHandle(group('hey @mybot, do this'))).toEqual({ type: 'pass' });
    expect(f.shouldHandle(group('@mybot.'))).toEqual({ type: 'pass' });
  });

  // Regression: the dispatcher now runs default filters on synthesized
  // re-dispatches by default (security-by-default for allowlists, kill
  // switches, etc.), so any contextual gate whose logic depends on the
  // ORIGINATING inbound's metadata MUST opt out explicitly. Telegram
  // `callback_query` updates carry no `update.message`, so this filter
  // would reject every clarify tap (DM and group alike) without
  // `runOnSynthesized = false`. Pin the contract via the field, not via
  // a behavioural test, so the assertion fails the moment someone
  // deletes the line.
  it('declares runOnSynthesized=false so dispatcher skips it on clarify replays', () => {
    expect(f.runOnSynthesized).toBe(false);
  });
});
