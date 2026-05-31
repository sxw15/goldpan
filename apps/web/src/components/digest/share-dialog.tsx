'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { useCopyToClipboard } from '@/lib/clipboard';

interface Props {
  open: boolean;
  url: string | null;
  ttlDays: number | null;
  /** When true, render the "share link not configured" copy instead of the input row. */
  unavailable: boolean;
  loading: boolean;
  onClose: () => void;
  onCopy: () => void;
}

export function ShareDialog({ open, url, ttlDays, unavailable, loading, onClose, onCopy }: Props) {
  const t = useTranslations('digest');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { copied, copy, reset: resetCopied } = useCopyToClipboard(1400);

  // Drive `<dialog>` open/close imperatively. `showModal()` activates the
  // browser's modal semantics (focus trap, inert background, top layer);
  // doing this from React state alone via the `open` HTML attribute would
  // skip those and we would have to reinvent them.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // Reset the "Copied" feedback every time the dialog re-opens — without
  // this, opening after a previous copy briefly shows the old confirmation
  // tick before the user has done anything.
  useEffect(() => {
    if (open) resetCopied();
  }, [open, resetCopied]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) onClose();
  };

  const handleBackdropKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onClose();
    }
  };

  const handleCancel = (e: React.SyntheticEvent) => {
    e.preventDefault();
    onClose();
  };

  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      className="gp-modal gp-digest-share-dialog"
      onClick={handleBackdropClick}
      onKeyDown={handleBackdropKeyDown}
      onCancel={handleCancel}
      aria-labelledby="gp-digest-share-dialog-title"
    >
      <div className="gp-modal__panel">
        <h3 id="gp-digest-share-dialog-title" className="gp-modal__title">
          {unavailable ? t('share_dialog_unavailable_title') : t('share_dialog_title')}
        </h3>
        {unavailable ? (
          <p className="gp-modal__message">{t('share_dialog_unavailable_body')}</p>
        ) : (
          <>
            <p className="gp-modal__message">
              {t('share_dialog_description', { days: ttlDays ?? 0 })}
            </p>
            <div className="gp-digest-share-dialog__row">
              <input
                readOnly
                value={loading ? t('share_dialog_loading') : (url ?? '')}
                className="gp-digest-share-dialog__input"
                aria-label={t('share_dialog_title')}
              />
              <button
                type="button"
                className="gp-digest-share-dialog__copy"
                disabled={loading || !url}
                onClick={async () => {
                  if (!url) return;
                  if (await copy(url)) onCopy();
                }}
              >
                {copied ? t('share_dialog_copied') : t('share_dialog_copy')}
              </button>
            </div>
          </>
        )}
        <div className="gp-modal__actions">
          <button type="button" className="gp-modal__btn" onClick={onClose}>
            {t('share_dialog_close')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
