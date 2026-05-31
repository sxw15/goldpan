import type { ILogObj, Logger } from 'tslog';
import type { FeishuCardReply, FeishuReplyPayload, FeishuTextReply } from '../types.js';

/**
 * Soft card ceiling. Lark's hard limit is ~30KB; the 5KB buffer covers the
 * JSON overhead for the surrounding message-envelope (msg_type, receive_id,
 * etc.).
 */
export const MAX_CARD_BYTES = 25_000;
const TRUNCATE_SUFFIX = '\n…(truncated)';

interface MutableTextBlock {
  text?: { content?: string };
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join('');
    if (utf8ByteLength(candidate) <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return chars.slice(0, lo).join('');
}

function findLargestTextBlock(elements: unknown[]): MutableTextBlock | null {
  let largest: MutableTextBlock | null = null;
  let largestSize = 0;
  for (const el of elements) {
    const e = el as MutableTextBlock;
    const size = e?.text?.content ? utf8ByteLength(e.text.content) : 0;
    if (size > largestSize) {
      largestSize = size;
      largest = e;
    }
  }
  return largest;
}

/**
 * Iteratively shrink the card's largest text block until the JSON fits
 * `MAX_CARD_BYTES`. Logs a `warn` on truncation. If even a minimal card
 * would overflow (pathological: header content alone > limit), logs `error`
 * and falls back to a plain-text reply rather than crashing the send.
 */
export function enforceCardSize(
  payload: FeishuCardReply,
  ctx: { logger: Logger<ILogObj>; cardType?: string; sessionKey?: string },
): FeishuReplyPayload {
  let json = JSON.stringify(payload.card);
  let jsonBytes = utf8ByteLength(json);
  if (jsonBytes <= MAX_CARD_BYTES) return payload;

  const originalBytes = jsonBytes;
  const cardCopy = structuredClone(payload.card) as { elements?: unknown[] };
  const suffixBytes = utf8ByteLength(TRUNCATE_SUFFIX);

  while (jsonBytes > MAX_CARD_BYTES) {
    const block = findLargestTextBlock(cardCopy.elements ?? []);
    const current = block?.text?.content;
    if (!block?.text || !current) break;
    const sourceText = current.endsWith(TRUNCATE_SUFFIX)
      ? current.slice(0, -TRUNCATE_SUFFIX.length)
      : current;
    const overshoot = jsonBytes - MAX_CARD_BYTES;
    const nextBudget = Math.max(0, utf8ByteLength(sourceText) - overshoot - suffixBytes - 32);
    const nextContent = `${truncateToUtf8Bytes(sourceText, nextBudget)}${TRUNCATE_SUFFIX}`;
    if (nextContent === current) break;
    block.text.content = nextContent;
    json = JSON.stringify(cardCopy);
    jsonBytes = utf8ByteLength(json);
  }

  if (jsonBytes > MAX_CARD_BYTES) {
    ctx.logger.error(
      'feishu card payload still exceeds 25KB after truncation; falling back to text',
      {
        originalBytes,
        truncatedBytes: jsonBytes,
        cardType: ctx.cardType,
        sessionKey: ctx.sessionKey,
      },
    );
    const fallback: FeishuTextReply = {
      kind: 'text',
      text: 'Response too large to render as card; see logs for details.',
    };
    return fallback;
  }

  ctx.logger.warn('feishu card payload exceeds 25KB, truncating', {
    originalBytes,
    truncatedBytes: jsonBytes,
    cardType: ctx.cardType,
    sessionKey: ctx.sessionKey,
  });
  return { kind: 'interactive', card: cardCopy as Record<string, unknown> };
}
