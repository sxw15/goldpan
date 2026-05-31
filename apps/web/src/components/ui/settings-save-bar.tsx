'use client';

import type { ReactNode } from 'react';

interface Props {
  visible: boolean;
  saving: boolean;
  /**
   * Caller is responsible for resetting `saving` to false on BOTH success and
   * rejection — this component swallows the Promise to satisfy React's
   * event-handler return-type rule, so an unhandled rejection here would leave
   * both buttons disabled forever.
   */
  onSave: () => void | Promise<void>;
  onUndo: () => void;
  saveLabel: ReactNode;
  savingLabel: ReactNode;
  undoLabel: ReactNode;
  /** a11y region label for screen readers. */
  regionLabel?: string;
}

export function SettingsSaveBar({
  visible,
  saving,
  onSave,
  onUndo,
  saveLabel,
  savingLabel,
  undoLabel,
  regionLabel,
}: Props) {
  return (
    <div
      className="gp-settings__save-bar"
      data-visible={visible ? 'true' : 'false'}
      // Only mark as a region (and announce label) when actually visible — an
      // aria-hidden region with role="region" is a contradictory a11y signal.
      {...(visible ? { role: 'region', 'aria-label': regionLabel } : { 'aria-hidden': true })}
    >
      {visible ? (
        <>
          <button
            type="button"
            className="gp-btn"
            data-variant="secondary"
            disabled={saving}
            onClick={onUndo}
          >
            {undoLabel}
          </button>
          <button
            type="button"
            className="gp-btn"
            data-variant="primary"
            disabled={saving}
            onClick={() => {
              void onSave();
            }}
          >
            {saving ? savingLabel : saveLabel}
          </button>
        </>
      ) : null}
    </div>
  );
}
