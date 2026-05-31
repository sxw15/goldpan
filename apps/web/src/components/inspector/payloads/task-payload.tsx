'use client';

import { useTranslations } from 'next-intl';
import { useFetchOnIdChange } from '@/hooks/use-fetch-on-id-change';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { TASK_STATUS_CHIP } from '../../../lib/task-display';
import { safeHref } from '../../../lib/url';
import { StateError } from '../../state/state-error';
import { StateLoading } from '../../state/state-loading';

interface TaskPayloadProps {
  id: number;
  onTitleReady: (title: string) => void;
}

type StatusKey = 'status_pending' | 'status_processing' | 'status_done' | 'status_error';

const fetchTask = (id: number, signal: AbortSignal) => getBrowserApiClient().getTask(id, signal);

export function TaskPayload({ id, onTitleReady }: TaskPayloadProps) {
  const t = useTranslations('task_payload');
  const { state, retry } = useFetchOnIdChange(id, fetchTask, {
    onReady: () => onTitleReady(t('title_fallback', { id })),
  });

  if (state.status === 'error') return <StateError error={state.error} onRetry={retry} />;
  if (state.status === 'loading') return <StateLoading />;
  const detail = state.data;

  const status = detail.status;
  const statusKey: StatusKey = `status_${status}` as StatusKey;

  return (
    <div className="gp-task-payload">
      <span className={`gp-status ${TASK_STATUS_CHIP[status]}`}>{t(statusKey)}</span>

      {detail.status === 'processing' && detail.pipelineStep && (
        <p className="gp-task-payload__pipeline-step">
          {t('pipeline_step_label', { step: detail.pipelineStep })}
        </p>
      )}

      {detail.status === 'error' && (
        <div className="gp-task-payload__error">
          <span className="gp-task-payload__error-kind">{detail.error.kind}</span>
          <p className="gp-task-payload__error-message">{detail.error.message.split('\n')[0]}</p>
        </div>
      )}

      {detail.sourceUrl && (
        <div className="gp-task-payload__source">
          <span className="gp-task-payload__source-label">{t('source_url_label')}</span>
          <a href={safeHref(detail.sourceUrl)} target="_blank" rel="noopener noreferrer">
            {detail.sourceUrl}
          </a>
        </div>
      )}

      <a className="gp-task-payload__fullpage-link" href={`/tasks/${id}`}>
        {t('fullpage_link')}
      </a>
    </div>
  );
}
