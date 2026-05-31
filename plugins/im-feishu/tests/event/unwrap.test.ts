import { describe, expect, it } from 'vitest';
import { unwrapFeishuEvent } from '../../src/event/unwrap.js';

describe('unwrapFeishuEvent', () => {
  it('returns empty header/inner for null/undefined/non-object', () => {
    expect(unwrapFeishuEvent(null)).toEqual({ header: {}, inner: {} });
    expect(unwrapFeishuEvent(undefined)).toEqual({ header: {}, inner: {} });
    expect(unwrapFeishuEvent(42)).toEqual({ header: {}, inner: {} });
    expect(unwrapFeishuEvent('payload')).toEqual({ header: {}, inner: {} });
  });

  it('extracts header + inner from un-flattened webhook payload', () => {
    const env = unwrapFeishuEvent({
      schema: '2.0',
      header: {
        event_type: 'im.message.receive_v1',
        event_id: 'evt-1',
        create_time: '1700000000000',
        tenant_key: 'tk',
        app_id: 'cli_x',
      },
      event: {
        sender: { sender_id: { open_id: 'ou_user' } },
        message: { message_id: 'om_1', chat_id: 'oc_1' },
      },
    });
    expect(env.header).toEqual({
      event_type: 'im.message.receive_v1',
      event_id: 'evt-1',
      create_time: '1700000000000',
      tenant_key: 'tk',
      app_id: 'cli_x',
    });
    expect(env.inner).toEqual({
      sender: { sender_id: { open_id: 'ou_user' } },
      message: { message_id: 'om_1', chat_id: 'oc_1' },
    });
  });

  it('extracts header + inner from SDK-flattened payload and STRIPS header siblings from inner', () => {
    // Regression: previously `inner = r` left `event_type`, `tenant_key`,
    // `create_time`, etc. dangling on the inner payload, so a future
    // reader writing `inner.event_type` would compile (because the type
    // shape is loose) and read the envelope's value into a place that
    // semantically holds inner-event data. The split keeps that door shut.
    const env = unwrapFeishuEvent({
      schema: '2.0',
      event_type: 'im.message.receive_v1',
      event_id: 'evt-1',
      create_time: '1700000000000',
      tenant_key: 'tk',
      app_id: 'cli_x',
      sender: { sender_id: { open_id: 'ou_user' } },
      message: { message_id: 'om_flat', chat_id: 'oc_1', chat_type: 'p2p' },
    });
    expect(env.header).toEqual({
      event_type: 'im.message.receive_v1',
      event_id: 'evt-1',
      create_time: '1700000000000',
      tenant_key: 'tk',
      app_id: 'cli_x',
    });
    // Header siblings MUST NOT leak into inner — see test docstring.
    const innerKeys = Object.keys(env.inner as Record<string, unknown>);
    expect(innerKeys).toEqual(expect.arrayContaining(['sender', 'message']));
    expect(innerKeys).not.toContain('event_type');
    expect(innerKeys).not.toContain('event_id');
    expect(innerKeys).not.toContain('create_time');
    expect(innerKeys).not.toContain('tenant_key');
    expect(innerKeys).not.toContain('app_id');
    expect(innerKeys).not.toContain('schema');
  });

  it('preserves card-action top-level fields (chat_id, operator, action) in flattened inner', () => {
    const env = unwrapFeishuEvent({
      schema: '2.0',
      event_type: 'card.action.trigger',
      event_id: 'evt-card',
      operator: { open_id: 'ou_user' },
      action: { value: { action: 'clarify' } },
      chat_id: 'oc_1',
    });
    expect(env.inner).toEqual({
      operator: { open_id: 'ou_user' },
      action: { value: { action: 'clarify' } },
      chat_id: 'oc_1',
    });
  });

  it('skips non-string header values silently (defensive against malformed payloads)', () => {
    const env = unwrapFeishuEvent({
      header: { event_type: 'im.message.receive_v1', create_time: 1700000000000 },
      event: { message: { message_id: 'om' } },
    });
    expect(env.header).toEqual({ event_type: 'im.message.receive_v1' });
    expect(env.header.create_time).toBeUndefined();
  });
});
