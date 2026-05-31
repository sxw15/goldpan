/**
 * Parse an IM runtime sessionKey back into the SessionRef fields it was built from.
 * Mirrors `buildSessionKeyFromRef(ref, mode)` in `@goldpan/im-runtime/inbound/session-key`;
 * the plugin keeps a local parser so it does not depend on im-runtime (see CLAUDE.md §1).
 *
 * Only the **4-segment** per_user form is reversible: the per_chat form drops
 * userId, so returning anything for 3-segment keys requires inventing a userId
 * (previously `userId ?? chatId`) and silently collides every group-chat user
 * onto the same subscription row. Instead: return null for 3-segment keys and
 * force the caller to supply `IntentExecutionContext.sessionRef` — which the
 * IM runtime's inbound dispatcher now always populates.
 *
 * Returns null for any malformed shape (empty segments, wrong count).
 */
export interface SessionRefFromKey {
  channelId: string;
  accountId: string;
  chatId: string;
  userId: string;
}

export function parseSessionKey(sessionKey: string): SessionRefFromKey | null {
  const parts = sessionKey.split(':');
  if (parts.length !== 4) return null;
  if (parts.some((p) => p === '')) return null;
  const [channelId, accountId, chatId, userId] = parts;
  return { channelId, accountId, chatId, userId };
}
