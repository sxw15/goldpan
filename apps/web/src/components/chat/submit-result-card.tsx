'use client';

import { useTranslations } from 'next-intl';

interface SubmitResultProps {
  result: {
    status: 'accepted' | 'duplicate' | 'rejected';
    taskId?: string;
    reason?: string;
    warnings?: string[];
    /** Forwarded from ChatMessage.submitResult; unused here (rendered by
     * DuplicateBubbleCard) but accepted so callers can pass the full object. */
    existingTaskId?: number | null;
    existingSourceId?: number;
    existingUrl?: string;
  };
}

export function SubmitResultCard({ result }: SubmitResultProps) {
  const t = useTranslations('chat');

  return (
    <div className={`gp-submit-confirm gp-submit-confirm--${result.status}`}>
      {result.status === 'accepted' && (
        <span className="gp-submit-confirm__text">
          {t('submit_accepted', { taskId: result.taskId ?? '' })}
        </span>
      )}
      {result.status === 'duplicate' && <span>{t('submit_duplicate')}</span>}
      {result.status === 'rejected' && <span>{result.reason ?? t('submit_rejected')}</span>}
      {result.warnings && result.warnings.length > 0 && (
        <div className="gp-submit-confirm__warnings">{result.warnings.join('; ')}</div>
      )}
    </div>
  );
}
