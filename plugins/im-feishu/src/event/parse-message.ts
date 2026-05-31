import type { InboundMessage } from '@goldpan/im-runtime';
import { unwrapFeishuEvent } from './unwrap.js';

interface PostNode {
  tag?: string;
  text?: string;
  user_name?: string;
  user_id?: string;
}
type PostBody = PostNode[][];

function readableTextFromNode(node: PostNode): string | null {
  // Text and inline-link nodes always carry a `text` field.
  if ((node.tag === 'text' || node.tag === 'a') && typeof node.text === 'string') {
    return node.text;
  }
  // `at` nodes carry the visible mention text under `user_name` (Lark post
  // schema). Without this branch the visible "@alice" would silently
  // disappear from the conversation text — that is real content loss for
  // rich-text posts because the mention never reaches intent handling
  // or conversation history. `@all` is encoded as `user_id: 'all'`
  // and conventionally rendered "@所有人"; we surface it as `@all` to
  // keep the textual representation channel-agnostic.
  if (node.tag === 'at') {
    if (typeof node.user_name === 'string' && node.user_name.length > 0) {
      const name = node.user_name.startsWith('@') ? node.user_name : `@${node.user_name}`;
      return name;
    }
    if (node.user_id === 'all') return '@all';
  }
  return null;
}

function extractTextFromPostContent(content: string): string {
  let parsed: { content?: PostBody };
  try {
    parsed = JSON.parse(content);
  } catch {
    return '';
  }
  const rows = parsed.content ?? [];
  const lines: string[] = [];
  for (const row of rows) {
    const texts: string[] = [];
    for (const node of row) {
      const t = readableTextFromNode(node);
      if (t !== null) texts.push(t);
    }
    // Rows with only non-readable nodes (e.g. `img`) contribute nothing
    // useful — skip them entirely rather than emitting a blank line that
    // would look like a paragraph break.
    if (texts.length === 0) continue;
    lines.push(texts.join(''));
  }
  return lines.join('\n');
}

const CONTENT_TYPE_MAP: Record<string, InboundMessage['contentType']> = {
  text: 'text',
  post: 'text',
  image: 'image',
  voice: 'voice',
  audio: 'voice',
  video: 'video',
  media: 'video',
  file: 'file',
};

/**
 * Translate a Lark `im.message.receive_v1` event into an `InboundMessage`,
 * or return null for malformed events that should be dropped rather than
 * dispatched.
 *
 * Accepts both the flattened payload that `@larksuiteoapi/node-sdk`
 * delivers to registered handlers (`{ ...header, ...event }` at top
 * level — verified against v1.61.1) and the un-flattened webhook /
 * fixture JSON (`{ header, event }`). See `unwrap.ts` for the full
 * rationale.
 *
 * Null returns for:
 *   - missing required fields (message_id, chat_id, chat_type, message_type),
 *   - no resolvable userId (every branch of sender_id is empty), which would
 *     otherwise emit a malformed per_user sessionKey (trailing `:`) and
 *     silently degrade clarify-replay authorization to "compares empty
 *     string to empty string".
 */
export function parseFeishuMessage(
  raw: unknown,
  ctx: { accountId: string },
): InboundMessage | null {
  const { header, inner } = unwrapFeishuEvent(raw);
  const m = inner.message;
  if (!m?.message_id || !m.chat_id || !m.chat_type || !m.message_type) return null;

  const userId =
    inner.sender?.sender_id?.open_id ??
    inner.sender?.sender_id?.union_id ??
    inner.sender?.sender_id?.user_id;
  if (!userId) return null;
  const messageType = m.message_type;
  const contentType = CONTENT_TYPE_MAP[messageType] ?? 'other';

  let text: string | undefined;
  if (messageType === 'text' && typeof m.content === 'string') {
    try {
      const parsed = JSON.parse(m.content) as { text?: string };
      if (typeof parsed.text === 'string') text = parsed.text;
    } catch {
      // Malformed content — leave text undefined. The dispatcher will treat
      // the message as 'other'-typed if downstream filters reject non-text
      // content types; keeping the contentType='text' is misleading but the
      // practical consequence is a clean drop.
    }
  } else if (messageType === 'post' && typeof m.content === 'string') {
    text = extractTextFromPostContent(m.content);
  }

  const receivedAt = header.create_time ? new Date(Number(header.create_time)) : new Date();

  const result: InboundMessage = {
    channelId: 'feishu',
    accountId: ctx.accountId,
    chatId: m.chat_id,
    userId,
    platformMsgId: m.message_id,
    contentType,
    raw,
    receivedAt,
    ...(text !== undefined ? { text } : {}),
    ...(m.chat_type === 'group' && m.thread_id ? { threadId: m.thread_id } : {}),
  };
  return result;
}
