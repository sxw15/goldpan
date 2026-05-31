'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

export interface ClarifyChipProps {
  intentKey: string;
  payload?: string;
  onClick: (intentKey: string, payload?: string) => void;
  disabled?: boolean;
}

/**
 * Single clarify chip — surfaces one of the classifier's `structuredOptions`
 * as an interactive button. Click dispatches the user's intent back via the
 * parent's `onClick`. Two label paths:
 *   1) `resolve_tracking_entity` (P4 deferred resolver) — each candidate
 *      entity is unique, so the label has to come from the payload's
 *      `entityName`, not an i18n key.
 *   2) Anything else — `intent_classifier.clarify_option.<intentKey>` keyed
 *      label (added by P2/P3 for the core intent enum).
 */
export function ClarifyChip({ intentKey, payload, onClick, disabled }: ClarifyChipProps) {
  const t = useTranslations('intent_classifier.clarify_option');

  const label = useMemo(() => {
    if (intentKey === 'resolve_tracking_entity' && payload) {
      try {
        const parsed = JSON.parse(payload) as { entityName?: string };
        if (parsed.entityName) return parsed.entityName;
      } catch {
        // Fall through to i18n key — defensive against malformed server payloads.
      }
    }
    return t(intentKey);
  }, [intentKey, payload, t]);

  return (
    <button
      type="button"
      className="gp-clarify-chip"
      onClick={() => {
        if (disabled) return;
        onClick(intentKey, payload);
      }}
      disabled={disabled}
    >
      {label}
    </button>
  );
}
