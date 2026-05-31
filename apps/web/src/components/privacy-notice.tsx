'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'goldpan_privacy_accepted';

export function PrivacyNotice() {
  const [dismissed, setDismissed] = useState(true); // default hidden to avoid flash
  const t = useTranslations('privacy');

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  if (dismissed) return null;

  const handleDismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* storage unavailable */
    }
    setDismissed(true);
  };

  return (
    <div className="gp-privacy" role="status">
      <p className="gp-privacy__text">
        <strong>{t('notice_title')}</strong> {t('notice')}
      </p>
      <button
        type="button"
        onClick={handleDismiss}
        className="gp-privacy__dismiss"
        aria-label={t('dismiss')}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
