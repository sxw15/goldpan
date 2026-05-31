/**
 * Detects Telegram API 400 errors caused by HTML parse failures so callers
 * can retry the same text without `parse_mode`. Covers the common
 * descriptions Bot API returns for bad HTML (unclosed tags, unsupported
 * tags, unescaped `<`/`>` inside content, etc.).
 */
export function isTelegramParseEntitiesError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { error_code?: unknown; description?: unknown };
  if (e.error_code !== 400) return false;
  if (typeof e.description !== 'string') return false;
  return /can't parse entities|unsupported start tag|unmatched end tag|unexpected end tag/i.test(
    e.description,
  );
}

/**
 * Converts Telegram-flavored HTML back to plain text for the fallback path
 * after `isTelegramParseEntitiesError`. Without this, dropping `parse_mode`
 * would leave literal `<i>`/`<a>`/`<b>` visible to the user.
 *
 * Scope: only the tags markdownToTelegramHtml emits plus the entity escapes
 * Telegram's HTML parse mode requires (`&lt;`/`&gt;`/`&amp;`/`&quot;`).
 */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|pre|code|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
