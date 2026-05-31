import type { InboundMessage, SessionRef } from '../types.js';
import { buildSessionKeyFromRef, type RoutingMode } from './session-key.js';

export type { RoutingMode } from './session-key.js';

export interface SessionRouterOptions {
  /** `per_chat` (default) shares one session for everyone in the chat; `per_user` isolates per sender. */
  routingMode: RoutingMode;
}

export class SessionRouter {
  constructor(private opts: SessionRouterOptions) {}

  buildSessionKey(msg: InboundMessage): string {
    return buildSessionKeyFromRef(this.buildSessionRef(msg), this.opts.routingMode);
  }

  buildSessionRef(msg: InboundMessage): SessionRef {
    return {
      channelId: msg.channelId,
      accountId: msg.accountId,
      chatId: msg.chatId,
      userId: msg.userId,
      ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
    };
  }

  /**
   * Derive the sessionKey from an already-built ref. The dispatcher hot-path
   * builds the ref once for filters / FIFO lock and then needs the key — calling
   * `buildSessionKey(msg)` would re-allocate the ref.
   */
  sessionKeyForRef(ref: SessionRef): string {
    return buildSessionKeyFromRef(ref, this.opts.routingMode);
  }
}

export type ParsedSessionKey =
  | {
      scope: 'per_chat';
      channelId: string;
      accountId: string;
      chatId: string;
      threadId?: string;
    }
  | {
      scope: 'per_user';
      channelId: string;
      accountId: string;
      chatId: string;
      userId: string;
      threadId?: string;
    };

/**
 * Inverse of `SessionRouter.buildSessionKey` — inspects a sessionKey produced
 * by this router and returns the full actor tuple (channel/account/chat, plus
 * userId when per_user, plus threadId when the originating message was
 * threaded).
 *
 * SessionKey format (emitted by `buildSessionKeyFromRef`):
 *   per_chat:  `<channelId>:<accountId>:<chatId>[:t=<threadId>]`
 *   per_user:  `<channelId>:<accountId>:<chatId>:<userId>[:t=<threadId>]`
 *
 * Caller invariants (violating these breaks round-trip):
 *   1. None of `channelId`, `accountId`, `chatId`, `userId`, `threadId` may
 *      contain `:`.
 *   2. `chatId` / `userId` must not start with `t=` (would be misread as a
 *      trailing threadId).
 *
 * Current adapters satisfy these: Telegram chatId is numeric (optional `-`);
 * Feishu uses typed id prefixes (`oc_`, `omt_`, `ou_`). Future adapters
 * (Slack threads, Discord, WeChat) MUST re-verify before shipping.
 *
 * Exported so channel adapters can authorize replayable artifacts (e.g.
 * clarify button callbacks) without re-deriving the segment layout.
 */
export function parseSessionKey(sessionKey: string): ParsedSessionKey | null {
  const parts = sessionKey.split(':');
  let threadId: string | undefined;
  const last = parts[parts.length - 1];
  if (last?.startsWith('t=')) {
    threadId = last.slice(2);
    parts.pop();
  }
  if (parts.length === 3) {
    const base = {
      scope: 'per_chat' as const,
      channelId: parts[0],
      accountId: parts[1],
      chatId: parts[2],
    };
    return threadId !== undefined ? { ...base, threadId } : base;
  }
  if (parts.length === 4) {
    const base = {
      scope: 'per_user' as const,
      channelId: parts[0],
      accountId: parts[1],
      chatId: parts[2],
      userId: parts[3],
    };
    return threadId !== undefined ? { ...base, threadId } : base;
  }
  return null;
}
