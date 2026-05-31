const DEFAULT_MAX = 4096;
// Reserve space for closing/opening HTML tags injected during rebalancing.
// Telegram supports ~6 nestable format tags; longest close is </blockquote> (13).
// 6 tags × 13 chars = 78; round up to 80 for safety.
const HTML_TAG_HEADROOM = 80;

/** Track which HTML tags are open/closed and rebalance across chunk boundaries. */
function rebalanceHtmlChunks(chunks: string[], maxLen: number): string[] {
  if (chunks.length <= 1) return chunks;

  const TAG_RE = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
  const VOID_TAGS = new Set(['br', 'hr', 'img']);
  const result: string[] = [];
  const carryOver: { tagName: string; openTag: string }[] = [];

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (carryOver.length > 0) {
      chunk = carryOver.map((t) => t.openTag).join('') + chunk;
    }

    const openStack: { tagName: string; openTag: string }[] = [];
    TAG_RE.lastIndex = 0;
    while (true) {
      const m = TAG_RE.exec(chunk);
      if (m === null) break;
      const isClosing = m[0][1] === '/';
      const tagName = m[1].toLowerCase();
      if (VOID_TAGS.has(tagName)) continue;
      if (isClosing) {
        const idx = openStack.map((e) => e.tagName).lastIndexOf(tagName);
        if (idx !== -1) openStack.splice(idx, 1);
      } else {
        openStack.push({ tagName, openTag: m[0] });
      }
    }

    if (openStack.length > 0) {
      chunk += openStack
        .slice()
        .reverse()
        .map((t) => `</${t.tagName}>`)
        .join('');
    }

    // If rebalancing pushed chunk over limit, hard-truncate at maxLen
    // and carry the overflow into a new chunk (inserted right after this one)
    if (chunk.length > maxLen) {
      const breakAt = chunk.lastIndexOf(' ', maxLen);
      const splitAt = breakAt > 0 ? breakAt : maxLen;
      const overflow = chunk.slice(splitAt).trimStart();
      chunk = chunk.slice(0, splitAt);
      if (overflow.length > 0) {
        // Insert overflow as a new chunk to be processed next
        chunks.splice(i + 1, 0, overflow);
      }
    }

    result.push(chunk);
    carryOver.length = 0;
    carryOver.push(...openStack);
  }

  return result;
}

/**
 * Pick a safe split point inside an oversized paragraph.
 *
 * Preferred split = at the last whitespace within `splitLimit`. If there's no
 * whitespace (e.g. a 4000-char URL or a giant attribute string), fall back to
 * the last `>` so the cut lands AFTER a complete HTML tag rather than mid-tag.
 * Cutting inside `<a href="..."` would emit a malformed open tag that the
 * downstream rebalancer can't see — and Telegram would reject the chunk.
 *
 * If neither a space nor a `>` exists in range, hard-truncate at `splitLimit`.
 * That residual case is best-effort: it can still produce malformed HTML, but
 * it's strictly better than the previous unconditional hard-truncate.
 */
function pickSplitPoint(remaining: string, splitLimit: number): number {
  const spaceAt = remaining.lastIndexOf(' ', splitLimit);
  if (spaceAt > 0) return spaceAt;
  const tagEndAt = remaining.lastIndexOf('>', splitLimit);
  if (tagEndAt > 0) return tagEndAt + 1;
  return splitLimit;
}

/**
 * Split text at paragraph boundaries so each chunk fits within `maxLen`.
 * If a single paragraph exceeds `maxLen`, force-split at the safest point
 * available (whitespace, then end-of-tag, then hard cut). After splitting,
 * rebalances HTML tags across chunk boundaries so each chunk is valid.
 */
export function splitForTelegram(text: string, maxLen = DEFAULT_MAX): string[] {
  if (text.length <= maxLen) return [text];

  // Reserve headroom for HTML close/open tags injected during rebalancing
  const splitLimit = maxLen - HTML_TAG_HEADROOM;

  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (candidate.length <= splitLimit) {
      current = candidate;
    } else {
      if (current.length > 0) chunks.push(current);
      // If the single paragraph itself is too long, force-split it
      if (para.length > splitLimit) {
        let remaining = para;
        while (remaining.length > splitLimit) {
          const splitAt = pickSplitPoint(remaining, splitLimit);
          chunks.push(remaining.slice(0, splitAt));
          remaining = remaining.slice(splitAt).trimStart();
        }
        current = remaining;
      } else {
        current = para;
      }
    }
  }
  if (current.length > 0) chunks.push(current);
  return rebalanceHtmlChunks(chunks, maxLen);
}
