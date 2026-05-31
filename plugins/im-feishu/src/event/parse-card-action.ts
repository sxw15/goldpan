import type { CardActionValue } from '../types.js';
import { unwrapFeishuEvent } from './unwrap.js';

export interface CardActionParsed {
  kind: 'card-action';
  value: CardActionValue;
  chatId: string;
  userOpenId: string;
}

function isValidValue(v: unknown): v is CardActionValue {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.action !== 'clarify') return false;
  if (typeof o.conversationMessageId !== 'number' || !Number.isInteger(o.conversationMessageId))
    return false;
  if (typeof o.optionIndex !== 'number' || !Number.isInteger(o.optionIndex) || o.optionIndex < 0)
    return false;
  return true;
}

/**
 * Parse a Lark `card.action.trigger` event payload into a validated
 * `CardActionParsed` record. Returns null for malformed / foreign values
 * so the adapter can silently drop them without logging noise.
 *
 * Accepts both the flattened payload that `@larksuiteoapi/node-sdk`
 * delivers to handlers (`{ ...header, ...event }` at top level — verified
 * against v1.61.1) and the un-flattened webhook / fixture JSON
 * (`{ header, event }`). See `unwrap.ts` for the full rationale.
 */
export function parseCardActionEvent(raw: unknown): CardActionParsed | null {
  const { inner } = unwrapFeishuEvent(raw);
  if (!inner.chat_id || !inner.operator?.open_id) return null;
  const v = inner.action?.value;
  if (!isValidValue(v)) return null;
  return {
    kind: 'card-action',
    value: v,
    chatId: inner.chat_id,
    userOpenId: inner.operator.open_id,
  };
}
