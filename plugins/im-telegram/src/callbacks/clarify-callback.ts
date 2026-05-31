import type { ConversationRepository } from '@goldpan/core/conversation';
import { type ReplayAuthActor, resolveClarifyReplay, type SessionRef } from '@goldpan/im-runtime';

/**
 * P3 legacy shape — `clarify:{convMsgId}:{optIdx}` —— pre-P4 inline keyboards
 * encoded the option **index** into the assistant turn's `metadata.options[]`.
 * The handler `resolveClarifyReplay` looks the label up and re-dispatches it
 * through the classifier. P4 prefers `keyed` (below) but this branch must stay
 * working for keyboards Telegram already delivered to users before the upgrade.
 */
export interface ClarifyCallbackPayloadLegacy {
  shape: 'legacy';
  conversationMessageId: number;
  optionIndex: number;
}

/**
 * P4 keyed shape — `clarify:{convMsgId}:{intentKey}[:{payload}]`. The chip
 * encodes the resolved `intentKey` (and an opaque `payload`) so the callback
 * handler can dispatch with `forcedIntent`, skipping the classifier entirely.
 * Matches the web ClarifyResultCard chip semantics added in Task 8 / 7.5.
 */
export interface ClarifyCallbackPayloadKeyed {
  shape: 'keyed';
  conversationMessageId: number;
  intentKey: string;
  payload?: string;
}

export type ClarifyCallbackPayload = ClarifyCallbackPayloadLegacy | ClarifyCallbackPayloadKeyed;

/**
 * Parse the `callback_data` string Telegram sends back when a user taps a
 * clarify inline-keyboard button. Returns `null` for foreign / malformed data
 * so the caller can drop silently.
 *
 * Disambiguation between legacy and keyed: `parts[2]` is a pure integer for
 * legacy (option index) but a `ClarifyOptionKey` identifier for keyed
 * (`create_note`, `submit_url`, …). `Number.isInteger(Number(parts[2]))`
 * cleanly separates them — all P4 intentKeys contain at least one non-digit.
 */
export function parseClarifyCallback(raw: string): ClarifyCallbackPayload | null {
  const parts = raw.split(':');
  if (parts.length < 3 || parts[0] !== 'clarify') return null;
  const conversationMessageId = Number(parts[1]);
  if (!Number.isInteger(conversationMessageId)) return null;

  // Legacy: 3 parts total + parts[2] parses cleanly as integer.
  if (parts.length === 3) {
    const asNumber = Number(parts[2]);
    if (Number.isInteger(asNumber)) {
      return { shape: 'legacy', conversationMessageId, optionIndex: asNumber };
    }
  }

  // Keyed: 3+ parts, parts[2] is a non-empty identifier. payload may itself
  // contain ':' (JSON blob etc), so re-join everything after parts[2].
  const intentKey = parts[2];
  if (!intentKey) return null;
  const payload = parts.length > 3 ? parts.slice(3).join(':') : undefined;
  return payload === undefined
    ? { shape: 'keyed', conversationMessageId, intentKey }
    : { shape: 'keyed', conversationMessageId, intentKey, payload };
}

export type ClarifyReplay =
  | { status: 'ok'; text: string; sessionKey: string; sessionRef: SessionRef }
  | { status: 'stale' };

/** Alias re-exported for test-site stability. Prefer importing `ReplayAuthActor`. */
export type ClarifyReplayActor = ReplayAuthActor;

/**
 * Telegram-shaped wrapper around the shared `resolveClarifyReplay` helper.
 * Kept as a named export so existing consumers / tests don't have to change
 * import paths; the actual metadata-parsing + authorization logic lives in
 * `@goldpan/im-runtime/inbound/clarify-replay.ts` (CLAUDE.md §3 中央化防御).
 *
 * Collapses every stale reason into a single `{status: 'stale'}` because
 * Phase 1 behavior surfaced an unconditional "expired" reply regardless of
 * cause; callers wanting the typed reason should migrate to
 * `resolveClarifyReplay` directly.
 */
export function buildClarifyReplay(
  payload: ClarifyCallbackPayloadLegacy,
  repo: ConversationRepository,
  actor: ClarifyReplayActor,
): ClarifyReplay {
  const result = resolveClarifyReplay({
    repo,
    conversationMessageId: payload.conversationMessageId,
    optionIndex: payload.optionIndex,
    actor,
  });
  if (result.status === 'ok') {
    return {
      status: 'ok',
      text: result.text,
      sessionKey: result.sessionKey,
      sessionRef: result.sessionRef,
    };
  }
  return { status: 'stale' };
}
