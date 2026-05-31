'use client';

import { useEffect, useRef } from 'react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el || !open) return;
    if (!el.open) el.showModal();
  }, [open]);

  // Close on backdrop click (or equivalent keyboard activation on backdrop)
  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      onCancel();
    }
  };

  const handleBackdropKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onCancel();
    }
  };

  // Handle native close (Escape key)
  const handleCancel = (e: React.SyntheticEvent) => {
    e.preventDefault();
    onCancel();
  };

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="gp-modal"
      onClick={handleBackdropClick}
      onKeyDown={handleBackdropKeyDown}
      onCancel={handleCancel}
    >
      <div className="gp-modal__panel">
        <h3 className="gp-modal__title">{title}</h3>
        <p className="gp-modal__message">{message}</p>
        <div className="gp-modal__actions">
          <button type="button" className="gp-modal__btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`gp-modal__btn ${danger ? 'gp-modal__btn--danger' : 'gp-modal__btn--primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
