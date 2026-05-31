import { describe, expect, it } from 'vitest';
import { parseFeishuMessage } from '../../src/event/parse-message.js';

const baseEvent = (overrides: Record<string, unknown> = {}) => ({
  header: {
    event_id: 'evt-1',
    event_type: 'im.message.receive_v1',
    tenant_key: 'tk',
    app_id: 'cli_x',
    create_time: '1700000000000',
  },
  event: {
    sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user', user_id: 'uid' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"hello world"}',
    },
    ...overrides,
  },
});

describe('parseFeishuMessage', () => {
  it('parses a P2P text message', () => {
    const msg = parseFeishuMessage(baseEvent(), { accountId: 'cli_x' });
    expect(msg).toMatchObject({
      channelId: 'feishu',
      accountId: 'cli_x',
      chatId: 'oc_1',
      userId: 'ou_user',
      platformMsgId: 'om_1',
      text: 'hello world',
      contentType: 'text',
    });
  });

  it('extracts text from a post message (Lark rich-text)', () => {
    const event = baseEvent({
      message: {
        message_id: 'om_2',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({
          title: 'Subject',
          content: [
            [{ tag: 'text', text: 'first line' }],
            [
              { tag: 'text', text: 'second ' },
              { tag: 'a', text: 'link', href: 'https://x' },
              { tag: 'text', text: ' tail' },
            ],
            [{ tag: 'at', user_id: 'ou_user' }],
            [{ tag: 'text', text: 'third' }],
          ],
        }),
      },
    });
    const msg = parseFeishuMessage(event, { accountId: 'cli_x' });
    expect(msg?.contentType).toBe('text');
    expect(msg?.text).toBe('first line\nsecond link tail\nthird');
  });

  it('keeps visible anchor text for link-only post rows', () => {
    const event = baseEvent({
      message: {
        message_id: 'om_link_only',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({
          content: [[{ tag: 'a', text: 'https://example.com', href: 'https://example.com' }]],
        }),
      },
    });
    const msg = parseFeishuMessage(event, { accountId: 'cli_x' });
    expect(msg?.contentType).toBe('text');
    expect(msg?.text).toBe('https://example.com');
  });

  it.each([
    ['image', 'image'],
    ['voice', 'voice'],
    ['audio', 'voice'],
    ['file', 'file'],
    ['media', 'video'],
    ['video', 'video'],
    ['sticker', 'other'],
  ] as const)('message_type=%s → contentType=%s, no text', (mt, ct) => {
    const event = baseEvent({
      message: {
        message_id: 'om_x',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: mt,
        content: '{}',
      },
    });
    const msg = parseFeishuMessage(event, { accountId: 'cli_x' });
    expect(msg?.contentType).toBe(ct);
    expect(msg?.text).toBeUndefined();
  });

  it('captures threadId for group messages with thread_id', () => {
    const event = baseEvent({
      message: {
        message_id: 'om_3',
        chat_id: 'oc_2',
        chat_type: 'group',
        thread_id: 'omt_1',
        message_type: 'text',
        content: '{"text":"thread reply"}',
      },
    });
    const msg = parseFeishuMessage(event, { accountId: 'cli_x' }) as { threadId?: string };
    expect(msg.threadId).toBe('omt_1');
  });

  it('does NOT set threadId for P2P chats even if thread_id is present (Lark never sets it there)', () => {
    const event = baseEvent({
      message: {
        message_id: 'om_3',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        thread_id: 'should-be-ignored',
        message_type: 'text',
        content: '{"text":"dm"}',
      },
    });
    const msg = parseFeishuMessage(event, { accountId: 'cli_x' }) as { threadId?: string };
    expect(msg.threadId).toBeUndefined();
  });

  it('returns null when message field is missing', () => {
    expect(parseFeishuMessage({ event: {} } as never, { accountId: 'cli_x' })).toBeNull();
  });

  it('returns null when sender_id has no open_id / union_id / user_id', () => {
    const event = baseEvent();
    event.event.sender = { sender_id: {} };
    expect(parseFeishuMessage(event, { accountId: 'cli_x' })).toBeNull();
  });

  it('falls back to union_id when open_id is absent', () => {
    const event = baseEvent();
    event.event.sender = { sender_id: { union_id: 'on_fallback' } };
    const msg = parseFeishuMessage(event, { accountId: 'cli_x' });
    expect(msg?.userId).toBe('on_fallback');
  });

  it('uses the configured accountId, not the event app_id', () => {
    const event = baseEvent();
    event.header.app_id = 'something-else';
    const msg = parseFeishuMessage(event, { accountId: 'cli_x' });
    expect(msg?.accountId).toBe('cli_x');
  });

  // The `@larksuiteoapi/node-sdk` (verified against v1.61.1) flattens v2
  // events before invoking handlers — both `header.*` and `event.*` are
  // spread to the top level. Real production payloads look like the
  // fixtures below; if these regress, every `im.message.receive_v1`
  // delivery starts dropping silently again.
  describe('against the SDK-flattened payload shape', () => {
    const flatEvent = (overrides: Record<string, unknown> = {}) => ({
      schema: '2.0',
      event_id: 'evt-1',
      event_type: 'im.message.receive_v1',
      tenant_key: 'tk',
      app_id: 'cli_x',
      create_time: '1700000000000',
      sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user', user_id: 'uid' } },
      message: {
        message_id: 'om_flat_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"hello flat"}',
      },
      ...overrides,
    });

    it('parses a flattened P2P text message', () => {
      const msg = parseFeishuMessage(flatEvent(), { accountId: 'cli_x' });
      expect(msg).toMatchObject({
        channelId: 'feishu',
        accountId: 'cli_x',
        chatId: 'oc_1',
        userId: 'ou_user',
        platformMsgId: 'om_flat_1',
        text: 'hello flat',
        contentType: 'text',
      });
    });

    it('captures threadId from a flattened group message', () => {
      const event = flatEvent({
        message: {
          message_id: 'om_flat_2',
          chat_id: 'oc_2',
          chat_type: 'group',
          thread_id: 'omt_flat',
          message_type: 'text',
          content: '{"text":"thread reply"}',
        },
      });
      const msg = parseFeishuMessage(event, { accountId: 'cli_x' }) as { threadId?: string };
      expect(msg.threadId).toBe('omt_flat');
    });

    it('reads create_time from the lifted top-level header field', () => {
      const event = flatEvent({ create_time: '1234567890000' });
      const msg = parseFeishuMessage(event, { accountId: 'cli_x' });
      expect(msg?.receivedAt.getTime()).toBe(1234567890000);
    });

    it('returns null when the flattened payload has no message field', () => {
      const event = { schema: '2.0', event_type: 'im.message.receive_v1', sender: {} };
      expect(parseFeishuMessage(event, { accountId: 'cli_x' })).toBeNull();
    });
  });

  // Lark `post` rich-text rows can contain `at` nodes whose visible text
  // sits on `user_name` (or `user_id: 'all'` for @all). Earlier versions
  // dropped those nodes entirely, silently truncating mention text out of
  // the conversation history.
  describe('post messages with `at` mention nodes', () => {
    it('keeps an inline @user mention from a post body', () => {
      const event = baseEvent({
        message: {
          message_id: 'om_at_1',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'post',
          content: JSON.stringify({
            content: [
              [
                { tag: 'text', text: 'hi ' },
                { tag: 'at', user_id: 'ou_alice', user_name: 'alice' },
                { tag: 'text', text: ' please help' },
              ],
            ],
          }),
        },
      });
      const msg = parseFeishuMessage(event, { accountId: 'cli_x' });
      expect(msg?.text).toBe('hi @alice please help');
    });

    it('preserves `@` prefix when user_name already includes it', () => {
      const event = baseEvent({
        message: {
          message_id: 'om_at_2',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'post',
          content: JSON.stringify({
            content: [
              [
                { tag: 'at', user_id: 'ou_bob', user_name: '@bob' },
                { tag: 'text', text: ' check' },
              ],
            ],
          }),
        },
      });
      const msg = parseFeishuMessage(event, { accountId: 'cli_x' });
      expect(msg?.text).toBe('@bob check');
    });

    it('renders @all when user_id is "all" and user_name is missing', () => {
      const event = baseEvent({
        message: {
          message_id: 'om_at_3',
          chat_id: 'oc_1',
          chat_type: 'group',
          message_type: 'post',
          content: JSON.stringify({
            content: [
              [
                { tag: 'at', user_id: 'all' },
                { tag: 'text', text: ' meeting at 3' },
              ],
            ],
          }),
        },
      });
      const msg = parseFeishuMessage(event, { accountId: 'cli_x' });
      expect(msg?.text).toBe('@all meeting at 3');
    });
  });
});
