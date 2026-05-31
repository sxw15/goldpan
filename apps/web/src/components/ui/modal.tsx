'use client';

import { type ReactNode, useEffect, useId } from 'react';
import { Btn } from './button';

export function Modal({
  heading,
  desc,
  onConfirm,
  onClose,
  closeLabel,
  confirmLabel,
  cancelLabel,
  confirmDisabled,
  cancelDisabled,
  danger,
  children,
}: {
  heading: ReactNode;
  desc?: ReactNode;
  /**
   * Optional. When omitted (together with confirmLabel/cancelLabel), the
   * confirm/cancel footer is suppressed and the caller is expected to render
   * its own action(s) inside `children`. Used by EnvFallbackModal to render
   * just a single Copy button.
   */
  onConfirm?: () => void;
  onClose: () => void;
  /** aria-label for the backdrop button (a11y). Caller passes translated text. */
  closeLabel: string;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** Disable the confirm button — used for in-flight async actions (e.g.
   * RestartPrompt during the server restart RPC). */
  confirmDisabled?: boolean;
  /** Disable the cancel button — mirrors `confirmDisabled` for symmetric
   * in-flight states where neither action is safe to fire. */
  cancelDisabled?: boolean;
  danger?: boolean;
  children?: ReactNode;
}) {
  const headingId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // cancelDisabled = "neither cancel nor close path is safe to fire"
      // (e.g. RestartPrompt mid-flight). Escape and backdrop click are
      // alternative close paths and MUST honor the same gate as the
      // visible cancel button — otherwise a user can dismiss the modal
      // mid-restart, re-open the pending banner, and trigger a second
      // restart while the first is still polling.
      if (e.key === 'Escape' && !cancelDisabled) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, cancelDisabled]);
  // Suppress the default confirm/cancel footer when the caller provides
  // no `onConfirm` — single-action modals (EnvFallbackModal) render their
  // own buttons inside `children`. Requiring `onConfirm` here prevents the
  // accidental "ghost button" case where a caller passes `confirmLabel`
  // alone and the rendered confirm button has `onClick={undefined}`.
  const showFoot =
    onConfirm !== undefined && (confirmLabel !== undefined || cancelLabel !== undefined);
  return (
    <>
      <button
        type="button"
        className="gp-modal-backdrop"
        aria-label={closeLabel}
        // Same gate as Escape (see above): a disabled cancel button must
        // block the backdrop click too, otherwise "cancelDisabled" is a
        // half-truth that only stops the obvious affordance.
        disabled={cancelDisabled}
        onClick={onClose}
      />
      <div className="gp-modal" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <div className="gp-modal__head">
          <h3 id={headingId} className="gp-modal__title">
            {heading}
          </h3>
          {desc ? <p className="gp-modal__sub">{desc}</p> : null}
        </div>
        {children ? <div className="gp-modal__body">{children}</div> : null}
        {showFoot ? (
          <div className="gp-modal__foot">
            {/* preventDefault on mousedown keeps the press from stealing focus
                away from a focused body field. Without it, clicking a footer
                button blurs the field FIRST (its onBlur runs, committing an
                in-progress draft and possibly inserting a row), the modal
                reflows, the button shifts out from under the cursor, and the
                mouseup lands on empty space → the click never fires → the
                action silently no-ops. The field's blur-commit is redundant
                here anyway: confirm handlers already flush() pending input on
                save. Keeping focus = no premature reflow = the click lands.
                (This stops the blur-driven reflow specifically — it does not
                make the footer immune to every reflow source.) */}
            <Btn
              sm
              onClick={onClose}
              onMouseDown={(e) => e.preventDefault()}
              disabled={cancelDisabled}
            >
              {cancelLabel}
            </Btn>
            <Btn
              sm
              kind={danger ? 'danger' : 'primary'}
              onClick={onConfirm}
              onMouseDown={(e) => e.preventDefault()}
              disabled={confirmDisabled}
            >
              {confirmLabel}
            </Btn>
          </div>
        ) : null}
      </div>
    </>
  );
}
