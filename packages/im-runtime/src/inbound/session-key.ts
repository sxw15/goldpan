import type { SessionRef } from '../types.js';

export type RoutingMode = 'per_chat' | 'per_user';

/**
 * Derive a canonical sessionKey from a fully-resolved `SessionRef`. Shared by
 * the inbound dispatch path (via `SessionRouter.buildSessionKey`) and the
 * outbound path (`IMRuntime.sendOutbound`) so both produce identical keys for
 * the same logical actor/chat.
 *
 * Format:
 *   per_chat:  `<channelId>:<accountId>:<chatId>[:t=<threadId>]`
 *   per_user:  `<channelId>:<accountId>:<chatId>:<userId>[:t=<threadId>]`
 *
 * The optional `t=<threadId>` suffix is appended when `ref.threadId` is set so
 * parallel threads in the same chat get distinct sessionKeys (Phase 2 decision
 * #4). `parseSessionKey` must stay in sync.
 */
export function buildSessionKeyFromRef(ref: SessionRef, mode: RoutingMode): string {
  const base = `${ref.channelId}:${ref.accountId}:${ref.chatId}`;
  let scoped: string;
  switch (mode) {
    case 'per_chat':
      scoped = base;
      break;
    case 'per_user':
      scoped = `${base}:${ref.userId}`;
      break;
    default:
      throw new Error(`buildSessionKeyFromRef: unknown routingMode: ${mode as string}`);
  }
  if (!ref.threadId) return scoped;
  // Fail-loud invariant: threadId must not contain `:`, otherwise
  // parseSessionKey would mis-parse the round-trip. Every current adapter
  // satisfies this (Feishu `omt_*`, Slack ts `123.456`), but asserting here
  // catches future channels the moment they introduce a composite thread id.
  if (ref.threadId.includes(':')) {
    throw new Error(`buildSessionKeyFromRef: threadId must not contain ':', got '${ref.threadId}'`);
  }
  return `${scoped}:t=${ref.threadId}`;
}
