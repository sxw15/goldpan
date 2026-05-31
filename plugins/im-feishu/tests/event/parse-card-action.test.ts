import { describe, expect, it } from 'vitest';
import { parseCardActionEvent } from '../../src/event/parse-card-action.js';

describe('parseCardActionEvent', () => {
  it('parses a clarify action with valid value', () => {
    const out = parseCardActionEvent({
      event: {
        operator: { open_id: 'ou_user' },
        action: { value: { action: 'clarify', conversationMessageId: 42, optionIndex: 1 } },
        chat_id: 'oc_1',
      },
    });
    expect(out).toEqual({
      kind: 'card-action',
      value: { action: 'clarify', conversationMessageId: 42, optionIndex: 1 },
      chatId: 'oc_1',
      userOpenId: 'ou_user',
    });
  });

  it('returns null when action.value is missing', () => {
    expect(
      parseCardActionEvent({
        event: { operator: { open_id: 'ou' }, action: {}, chat_id: 'oc_1' },
      }),
    ).toBeNull();
  });

  it('returns null on wrong action discriminator', () => {
    expect(
      parseCardActionEvent({
        event: {
          operator: { open_id: 'ou' },
          action: { value: { action: 'something_else', conversationMessageId: 1, optionIndex: 0 } },
          chat_id: 'oc_1',
        },
      }),
    ).toBeNull();
  });

  it('returns null when conversationMessageId is not an integer', () => {
    expect(
      parseCardActionEvent({
        event: {
          operator: { open_id: 'ou' },
          action: {
            value: { action: 'clarify', conversationMessageId: 'not-num', optionIndex: 0 },
          },
          chat_id: 'oc_1',
        },
      }),
    ).toBeNull();
  });

  it('returns null when optionIndex is negative', () => {
    expect(
      parseCardActionEvent({
        event: {
          operator: { open_id: 'ou' },
          action: { value: { action: 'clarify', conversationMessageId: 1, optionIndex: -1 } },
          chat_id: 'oc_1',
        },
      }),
    ).toBeNull();
  });

  it('returns null when chat_id is missing', () => {
    expect(
      parseCardActionEvent({
        event: {
          operator: { open_id: 'ou' },
          action: { value: { action: 'clarify', conversationMessageId: 1, optionIndex: 0 } },
        },
      }),
    ).toBeNull();
  });

  it('returns null when operator.open_id is missing', () => {
    expect(
      parseCardActionEvent({
        event: {
          operator: {},
          action: { value: { action: 'clarify', conversationMessageId: 1, optionIndex: 0 } },
          chat_id: 'oc_1',
        },
      }),
    ).toBeNull();
  });

  // The Lark SDK (verified against `@larksuiteoapi/node-sdk@1.61.1`,
  // `RequestHandle.parse` in `lib/index.js`) flattens `card.action.trigger`
  // payloads before invoking handlers — `event.operator`, `event.action`,
  // `event.chat_id` arrive at the top level. Without these regression
  // tests, every production clarify tap is dropped as malformed before
  // replay-auth or re-dispatch ever runs.
  describe('against the SDK-flattened payload shape', () => {
    it('parses a flattened clarify action', () => {
      const out = parseCardActionEvent({
        schema: '2.0',
        event_type: 'card.action.trigger',
        event_id: 'evt-card-1',
        operator: { open_id: 'ou_user' },
        action: { value: { action: 'clarify', conversationMessageId: 7, optionIndex: 0 } },
        chat_id: 'oc_flat',
      });
      expect(out).toEqual({
        kind: 'card-action',
        value: { action: 'clarify', conversationMessageId: 7, optionIndex: 0 },
        chatId: 'oc_flat',
        userOpenId: 'ou_user',
      });
    });

    it('returns null when flattened payload omits chat_id', () => {
      expect(
        parseCardActionEvent({
          schema: '2.0',
          event_type: 'card.action.trigger',
          operator: { open_id: 'ou_user' },
          action: { value: { action: 'clarify', conversationMessageId: 1, optionIndex: 0 } },
        }),
      ).toBeNull();
    });

    it('returns null when flattened payload has no operator.open_id', () => {
      expect(
        parseCardActionEvent({
          schema: '2.0',
          event_type: 'card.action.trigger',
          operator: {},
          action: { value: { action: 'clarify', conversationMessageId: 1, optionIndex: 0 } },
          chat_id: 'oc_flat',
        }),
      ).toBeNull();
    });
  });
});
