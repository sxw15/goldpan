'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

export type FieldStatusState = 'pristine' | 'saving' | 'saved' | 'pending-restart' | 'error';

/**
 * Inline status indicator rendered in SettingsField.status slot. Driven by
 * useFieldCommit hooks — they hold the state machine, this is the renderer.
 *
 * - pristine: no element (caller renders empty)
 * - saving:   gray "Saving" + ⏳
 * - saved:    green ✓ "Saved" (CSS fades to 0 over 2.5s)
 * - pending-restart: orange ⏎ "Saved · restart to take effect" (persistent
 *   until server restarts and page reloads)
 * - error: red ⚠ "Save failed: <message>" (persistent until next attempt)
 *
 * baselineDiffers shifts pending-restart message to mention .env divergence.
 *
 * Note for consumers (hooks calling FieldStatus): to replay the "saved" fade
 * animation on subsequent save attempts, pass a changing React `key` (e.g. a
 * monotonically incrementing attemptId) so the element remounts. CSS won't
 * auto-restart the animation if data-state="saved" reappears on the same node.
 */
export function FieldStatus({
  state,
  error,
  fieldName,
  baselineDiffers,
}: {
  state: FieldStatusState;
  error?: string | null;
  /** Field name for ARIA messages (e.g. "登录密码"). */
  fieldName?: string;
  baselineDiffers?: boolean;
}): ReactNode {
  const t = useTranslations('settings.field_status');

  if (state === 'pristine') return null;

  // Every state below sets an explicit aria-label on the span so the leading
  // emoji glyph (⏳ ✓ ⏎ ⚠), which is aria-hidden, doesn't appear in some
  // screen-reader announcements with combinations that ignore aria-hidden on
  // unicode symbols. The label also disambiguates which field this status
  // belongs to when multiple are on screen.
  //
  // Fallback path: when fieldName isn't supplied (component used outside its
  // typical SettingsField wrapper), the label drops the field-specific phrasing
  // and uses the plain status text — keeps the label populated rather than
  // leaking a literal "undefined" string.
  if (state === 'saving') {
    return (
      <span
        className="gp-field__status"
        data-state="saving"
        role="status"
        aria-label={fieldName ? t('saving_aria', { field: fieldName }) : t('saving')}
      >
        <span aria-hidden="true">⏳</span> {t('saving')}
      </span>
    );
  }

  if (state === 'saved') {
    return (
      <span
        className="gp-field__status"
        data-state="saved"
        role="status"
        aria-label={fieldName ? t('saved_aria', { field: fieldName }) : t('saved')}
      >
        <span aria-hidden="true">✓</span> {t('saved')}
      </span>
    );
  }

  if (state === 'pending-restart') {
    const shadowed = baselineDiffers === true;
    const bodyKey = shadowed ? 'pending_restart_shadowed' : 'pending_restart';
    // aria-label tracks the same shadowed/normal split as the visible text so
    // SR users hear the "baseline still has old value" warning instead of the
    // generic restart copy.
    const ariaKey = shadowed ? 'pending_restart_shadowed_aria' : 'pending_restart_aria';
    return (
      <span
        className="gp-field__status"
        data-state="pending-restart"
        role="status"
        aria-label={fieldName ? t(ariaKey, { field: fieldName }) : t(bodyKey)}
      >
        <span aria-hidden="true">⏎</span> {t(bodyKey)}
      </span>
    );
  }

  if (state === 'error') {
    // `error` is null when the hook's pickErrorForField found neither an
    // own-key nor a general/path-less error (cross-field-only failure).
    // The shell-level toast carries the real message in that case; inline
    // we just signal "save failed, look at the notice" so the user has a
    // hint to scroll up rather than a confusing empty-suffix "保存失败：".
    const detail = error && error.length > 0 ? error : null;
    const visibleKey = detail !== null ? 'error' : 'error_no_detail';
    const ariaKey = detail !== null ? 'error_aria' : 'error_no_detail_aria';
    return (
      <span
        className="gp-field__status"
        data-state="error"
        role="alert"
        aria-label={
          fieldName
            ? t(ariaKey, { field: fieldName, message: detail ?? '' })
            : t(visibleKey, { message: detail ?? '' })
        }
      >
        <span aria-hidden="true">⚠</span> {t(visibleKey, { message: detail ?? '' })}
      </span>
    );
  }

  return null;
}
