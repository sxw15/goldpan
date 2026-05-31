import type { InboundMessage } from '@goldpan/im-runtime';
import { describe, expect, it } from 'vitest';
import { FeishuGroupMentionFilter } from '../../src/filters/group-mention.js';
import { SentMessageCache } from '../../src/sent-message-cache.js';

const groupMsg = (
  overrides: Partial<{ text?: string; mentions?: unknown[]; parentId?: string }> = {},
): InboundMessage => ({
  channelId: 'feishu',
  accountId: 'cli_x',
  chatId: 'oc_1',
  userId: 'ou_user',
  platformMsgId: 'om_1',
  text: overrides.text,
  contentType: 'text',
  raw: {
    event: {
      message: {
        chat_type: 'group',
        mentions: overrides.mentions ?? [],
        ...(overrides.parentId !== undefined ? { parent_id: overrides.parentId } : {}),
      },
    },
  },
  receivedAt: new Date(),
});

const dmMsg = (text: string): InboundMessage => ({
  ...groupMsg({ text }),
  raw: { event: { message: { chat_type: 'p2p' } } },
});

describe('FeishuGroupMentionFilter', () => {
  const buildFilter = () =>
    new FeishuGroupMentionFilter({
      botOpenId: 'ou_bot',
      sentMessageCache: new SentMessageCache(),
    });

  it('passes DMs unconditionally', () => {
    expect(buildFilter().shouldHandle(dmMsg('anything'))).toEqual({ type: 'pass' });
  });

  it('passes group messages mentioning the bot via mentions[].id.open_id', () => {
    const msg = groupMsg({
      text: 'hi everyone',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Goldpan' }],
    });
    expect(buildFilter().shouldHandle(msg)).toEqual({ type: 'pass' });
  });

  it('passes group messages starting with /command', () => {
    expect(buildFilter().shouldHandle(groupMsg({ text: '/ask what is X' }))).toEqual({
      type: 'pass',
    });
  });

  it('rejects group messages with no mention, no command, no parent reply', () => {
    expect(buildFilter().shouldHandle(groupMsg({ text: 'no mention here' }))).toEqual({
      type: 'reject',
    });
  });

  it('rejects group messages mentioning a different open_id', () => {
    const msg = groupMsg({
      text: 'cc somebody',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_other_bot' }, name: 'Other' }],
    });
    expect(buildFilter().shouldHandle(msg)).toEqual({ type: 'reject' });
  });

  it('passes group messages replying to a recent bot-sent message (cache hit)', () => {
    const cache = new SentMessageCache();
    cache.markSent('oc_1', 'om_bot_reply');
    const filter = new FeishuGroupMentionFilter({ botOpenId: 'ou_bot', sentMessageCache: cache });
    const msg = groupMsg({ text: 'follow-up question', parentId: 'om_bot_reply' });
    expect(filter.shouldHandle(msg)).toEqual({ type: 'pass' });
  });

  it('rejects group reply when parent_id is unknown to the cache', () => {
    const filter = buildFilter();
    const msg = groupMsg({ text: 'follow-up', parentId: 'om_unknown' });
    expect(filter.shouldHandle(msg)).toEqual({ type: 'reject' });
  });

  it('declares runOnSynthesized=false so dispatcher skips it on clarify replays', () => {
    expect(buildFilter().runOnSynthesized).toBe(false);
  });

  // Filter consumes `msg.raw` via unwrapFeishuEvent, so it must accept
  // the SDK-flattened payload shape that adapter.ts forwards verbatim.
  // Without this branch, every DM and reply-to-bot follow-up is silently
  // rejected because chat_type / mentions / parent_id sit on top-level
  // `message`, not nested under `event.message`.
  describe('against the SDK-flattened payload shape', () => {
    const flatMsg = (
      overrides: Partial<{ text?: string; mentions?: unknown[]; parentId?: string }> = {},
    ): InboundMessage => ({
      channelId: 'feishu',
      accountId: 'cli_x',
      chatId: 'oc_1',
      userId: 'ou_user',
      platformMsgId: 'om_1',
      text: overrides.text,
      contentType: 'text',
      raw: {
        schema: '2.0',
        event_type: 'im.message.receive_v1',
        message: {
          chat_type: 'group',
          mentions: overrides.mentions ?? [],
          ...(overrides.parentId !== undefined ? { parent_id: overrides.parentId } : {}),
        },
      },
      receivedAt: new Date(),
    });

    const flatDm = (text: string): InboundMessage => ({
      ...flatMsg({ text }),
      raw: { schema: '2.0', event_type: 'im.message.receive_v1', message: { chat_type: 'p2p' } },
    });

    it('passes a flattened DM unconditionally', () => {
      expect(buildFilter().shouldHandle(flatDm('hi'))).toEqual({ type: 'pass' });
    });

    it('passes a flattened group message that mentions the bot', () => {
      const msg = flatMsg({
        text: 'hi everyone',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Goldpan' }],
      });
      expect(buildFilter().shouldHandle(msg)).toEqual({ type: 'pass' });
    });

    it('passes a flattened group reply when parent_id hits the sent cache', () => {
      const cache = new SentMessageCache();
      cache.markSent('oc_1', 'om_bot_reply');
      const filter = new FeishuGroupMentionFilter({ botOpenId: 'ou_bot', sentMessageCache: cache });
      const msg = flatMsg({ text: 'follow-up', parentId: 'om_bot_reply' });
      expect(filter.shouldHandle(msg)).toEqual({ type: 'pass' });
    });
  });
});
