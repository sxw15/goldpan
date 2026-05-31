import type * as lark from '@larksuiteoapi/node-sdk';

export interface SendMessageInput {
  /** Lark chat id (e.g. `oc_xxxx`). The adapter always sends to chat_id. */
  chatId: string;
  /** Optional thread parent id (e.g. `omt_xxxx`) for threaded replies. */
  parentId?: string;
  msgType: 'text' | 'interactive';
  /** JSON-encoded content per Lark API contract. */
  content: string;
}

export interface SendMessageResult {
  /** Lark `message_id` (e.g. `om_xxxx`). Captured for the SentMessageCache. */
  messageId?: string;
}

/**
 * Send a single message via the Lark SDK. Mirrors `fetchBotInfo`'s role: SDK
 * call shape lives here, consumers never see it. If the Lark SDK changes
 * `client.im.message.create`'s signature, only this file needs editing.
 *
 * Per Lark API v1 (verified in SDK v1.61):
 *   - `params.receive_id_type` is required; we always send to `chat_id`.
 *   - `data.content` must be a JSON-encoded string even for the `interactive`
 *     msg_type (Lark parses it server-side).
 *   - Response data lives under `.data.message_id`.
 */
export async function sendLarkMessage(
  client: lark.Client,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const result = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: input.chatId,
      ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
      msg_type: input.msgType,
      content: input.content,
    },
  });
  return { messageId: result.data?.message_id };
}
