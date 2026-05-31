'use client';

import { ChevronRight, FileText, Library } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

interface DuplicateBubbleCardProps {
  /** First (earliest) pipeline task for the existing source. May be `null`
   * when the original task was deleted but the source row remains; in that
   * case the "view original task" button is hidden. */
  existingTaskId: number | null;
  /** Source id used by the secondary "view in library" deep link. */
  existingSourceId: number;
  /** Original-form URL of the matched source — surfaced so the user can
   * confirm what was deduped without opening the link. */
  existingUrl?: string;
}

export function DuplicateBubbleCard({
  existingTaskId,
  existingSourceId,
  existingUrl,
}: DuplicateBubbleCardProps) {
  const t = useTranslations('chat.duplicate_bubble');

  return (
    <div className="gp-task-bubble gp-task-bubble--duplicate">
      <div className="gp-task-bubble__head gp-task-bubble__head--static">
        <span className="gp-task-bubble__icon" aria-hidden>
          <FileText size={14} />
        </span>
        <span className="gp-task-bubble__main">
          <span className="gp-task-bubble__row">
            <span className="gp-task-bubble__type gp-task-bubble__type--duplicate">
              {t('badge')}
            </span>
          </span>
          {existingUrl && (
            <span className="gp-task-bubble__title" title={existingUrl}>
              {existingUrl}
            </span>
          )}
        </span>
      </div>

      <div className="gp-task-bubble__body">
        <p className="gp-task-bubble__dup-msg">{t('body')}</p>
        <div className="gp-task-bubble__cta">
          {existingTaskId !== null && (
            <Link
              href={`/tasks/${existingTaskId}`}
              className="gp-btn"
              data-variant="primary"
              data-size="sm"
            >
              {t('cta.view_task')}
              <ChevronRight size={12} aria-hidden />
            </Link>
          )}
          <Link
            href={`/library?focus=${existingSourceId}&kind=source`}
            className="gp-btn"
            data-variant="ghost"
            data-size="sm"
          >
            <Library size={11} aria-hidden />
            {t('cta.view_in_library')}
          </Link>
        </div>
      </div>
    </div>
  );
}
