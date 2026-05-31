'use client';

import { useState } from 'react';
import { redactEnvFile } from '@/lib/secret-mask';
import { Modal } from './modal';

interface Props {
  envContent: string;
  onClose: () => void;
  onCopy: () => void;
  labels: {
    heading: string;
    desc: string;
    copyButton: string;
    closeLabel: string;
    /** Toggle button label when secrets are masked. */
    revealButton: string;
    /** Toggle button label when secrets are revealed. */
    hideButton: string;
    /** Caption shown above the masked content reminding users it's redacted. */
    maskedNote: string;
  };
}

/**
 * Escape hatch for write-back failures (EACCES / EPERM / EROFS / EBUSY) —
 * the server returns the would-be `.env` text so the user can paste it into
 * their docker volume / read-only mount manually. Default render REDACTS
 * known-secret values (AUTH_PASSWORD, *_API_KEY, *_TOKEN, *_SECRET) so a
 * casual fallback doesn't silently expose every credential the user already
 * had configured but wasn't editing this round. A "show plaintext" toggle
 * lets the user reveal when they need to verify before pasting; the Copy
 * button ALWAYS copies the original (unredacted) content so the destination
 * .env stays usable.
 *
 * i18n is caller-side (labels prop), matching the Modal / SettingsField /
 * SettingsSaveBar pattern — no `useTranslations` here.
 */
export function EnvFallbackModal({ envContent, onClose, onCopy, labels }: Props) {
  const [reveal, setReveal] = useState(false);
  const display = reveal ? envContent : redactEnvFile(envContent);
  return (
    <Modal
      heading={labels.heading}
      desc={labels.desc}
      closeLabel={labels.closeLabel}
      onClose={onClose}
    >
      {!reveal ? (
        <p className="gp-env-fallback__note" style={{ margin: '0 0 8px', fontSize: '12px' }}>
          {labels.maskedNote}
        </p>
      ) : null}
      <pre
        className="gp-env-fallback__content"
        style={{
          maxHeight: '40vh',
          overflow: 'auto',
          padding: '12px',
          background: 'var(--gp-color-surface-soft, #f6f6f6)',
          fontFamily: 'var(--gp-font-mono, ui-monospace, monospace)',
          fontSize: '12px',
          lineHeight: '1.5',
          margin: '12px 0',
          whiteSpace: 'pre',
        }}
      >
        {display}
      </pre>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button type="button" className="gp-btn" onClick={() => setReveal((r) => !r)}>
          {reveal ? labels.hideButton : labels.revealButton}
        </button>
        <button type="button" className="gp-btn" data-variant="primary" onClick={onCopy}>
          {labels.copyButton}
        </button>
      </div>
    </Modal>
  );
}
