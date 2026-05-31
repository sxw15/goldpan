/**
 * Submit-rejection code → user-facing localized text.
 *
 * Used by two paths that must not drift:
 *   1. `inputAction` mapping a live `/input` `rejected` response
 *   2. `ChatView` rendering a persisted assistant stub from history
 *
 * Returns `null` when the code is unknown; callers fall back to their own
 * default (raw reason or generic "submit failed" text).
 */
type ActionsTranslator = (key: string, values?: Record<string, string | number>) => string;

export function mapRejectCodeToText(
  code: string | null | undefined,
  t: ActionsTranslator,
  maxInputLength: number,
): string | null {
  switch (code) {
    case 'input_empty':
      return t('input_required');
    case 'text_too_short':
      return t('input_too_short');
    case 'text_too_long':
      return t('input_too_long', { limit: maxInputLength });
    case 'url_blocked':
      return t('url_blocked');
    case 'url_invalid':
      return t('url_invalid');
    case 'unknown':
      return t('submit_failed');
    default:
      return null;
  }
}
