export interface FeishuTextReply {
  kind: 'text';
  text: string;
}

/** Lark interactive-card JSON; opaque to consumers (the SDK validates). */
export type LarkCardJSON = Record<string, unknown>;

export interface FeishuCardReply {
  kind: 'interactive';
  card: LarkCardJSON;
}

/**
 * Concrete reply shape the Feishu adapter emits.
 *
 * Deliberately NOT `extends ChannelReplyPayload`: Layer A's
 * `ChannelReplyPayload = unknown`, and `interface T extends unknown` is
 * meaningless. The runtime relationship is enforced by `ChannelAdapter`
 * method signatures accepting `FeishuReplyPayload` (assignable to `unknown`);
 * the channel-internal `sendReply` casts back at the boundary.
 */
export type FeishuReplyPayload = FeishuTextReply | FeishuCardReply;

/**
 * Card-action button payload schema. JSON-serialised and round-tripped
 * through Lark's `action.value` field on every clarify button tap.
 */
export interface CardActionValue {
  action: 'clarify';
  conversationMessageId: number;
  optionIndex: number;
}
