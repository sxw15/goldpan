const POSITIVE_DECIMAL_INT = /^[1-9][0-9]*$/;

export function parseFocusId(focus: string | undefined | null): number | null {
  if (!focus || !POSITIVE_DECIMAL_INT.test(focus)) return null;
  const id = Number(focus);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

/**
 * Parse `?c=<id>` from Chat URL. Returns null for invalid / non-positive /
 * non-integer / absent. Same shape as `parseFocusId`; kept as a distinct export
 * for semantic clarity — if rules diverge later, only the conversation rule
 * changes here.
 */
export function parseConversationId(raw: string | undefined | null): number | null {
  return parseFocusId(raw);
}

/**
 * Return the URL unchanged if it starts with http:// or https://; otherwise return '#'.
 * Centralized to prevent consumer-side re-implementation (CLAUDE.md 防御纪律 #3).
 */
export function safeHref(url: string | null | undefined): string {
  if (!url) return '#';
  return /^https?:\/\//i.test(url) ? url : '#';
}

/**
 * Validate a kind value against a compile-time allowed list; fall back when invalid.
 * Used by useInspectorUrlSync and server-side generateMetadata.
 */
export function parseInspectorKind<K extends string>(
  raw: string | undefined | null,
  allowed: readonly K[],
  fallback: K,
): K {
  if (raw && (allowed as readonly string[]).includes(raw)) return raw as K;
  return fallback;
}
