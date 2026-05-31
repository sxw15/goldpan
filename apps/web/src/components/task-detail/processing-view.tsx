'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { ConfirmModal } from '@/components/confirm-modal';
import { useTz } from '@/components/tz-provider';
import { Hero } from '@/components/ui/hero';
import { formatTimeOfDay } from '@/lib/format';
import type { TaskLogEntry } from '@/lib/polling';
import { MobileBar } from './mobile-bar';
import { PIPELINE_STEPS, Pipeline, type PipelineStepKey, pipelineIndexOf } from './pipeline';
import { ProcessingHero } from './processing-hero';
import { StickyBar } from './sticky-bar';

export interface ProcessingViewProps {
  taskId: number;
  status: 'pending' | 'processing';
  sourceUrl: string | null;
  sourceTitle: string | null;
  createdAt: number | null;
  sourceKindLabel: string;
  pipelineStep: string | null;
  isPolling: boolean;
  logs: TaskLogEntry[];
  isDeleting: boolean;
  showDelete: boolean;
  onCancel: () => void;
  mobile?: boolean;
}

export function ProcessingView({
  taskId,
  status,
  sourceUrl,
  sourceTitle,
  createdAt,
  sourceKindLabel,
  pipelineStep,
  isPolling,
  logs,
  isDeleting,
  showDelete,
  onCancel,
  mobile,
}: ProcessingViewProps) {
  const t = useTranslations('task_detail');
  const td = useTranslations('task_detail.processing');
  const tStatus = useTranslations('task.status');
  const stepT = useTranslations('task_detail.pipeline_step');
  const tz = useTz();
  const locale = useLocale();

  const [confirmCancel, setConfirmCancel] = useState(false);

  const currentIdx = pipelineIndexOf(pipelineStep);
  const currentKey = (PIPELINE_STEPS[currentIdx] ?? PIPELINE_STEPS[0]) as PipelineStepKey;
  const currentStepName = stepT(currentKey);

  // memo: avoid retranslating these on every ~3s polling tick.
  const flavorLines = useMemo(
    () => [td('flavor_1'), td('flavor_2'), td('flavor_3'), td('flavor_4'), td('flavor_5')],
    [td],
  );

  const heroMeta: Array<{ label: string; value: string }> = [];
  if (createdAt != null)
    heroMeta.push({
      label: td('meta_created'),
      value: new Date(createdAt).toLocaleString(locale, { timeZone: tz }),
    });
  if (sourceKindLabel) heroMeta.push({ label: td('meta_source'), value: sourceKindLabel });

  const tail = logs.slice(-12);

  return (
    <div className={`gp-td-page${mobile ? ' gp-td-page--mobile' : ''}`}>
      <StickyBar
        status="processing"
        taskId={taskId}
        backHref="/library"
        backLabel={td('back')}
        taskCrumbLabel={td('crumb_task')}
        statusLabel={tStatus(status)}
        primaryMetric={
          currentIdx >= 0
            ? td.rich('sticky_metric', {
                step: currentStepName,
                n: currentIdx + 1,
                total: PIPELINE_STEPS.length,
                b: (ch) => <b>{ch}</b>,
              })
            : td('sticky_pending')
        }
        primaryAction={
          showDelete && !mobile ? (
            <button
              type="button"
              className="gp-btn"
              data-variant="secondary"
              onClick={() => setConfirmCancel(true)}
              disabled={isDeleting}
            >
              {isDeleting ? td('cancelling') : td('cancel_task')}
            </button>
          ) : null
        }
      />

      <div className="gp-td-main">
        <Hero
          eyebrow={`${td('eyebrow')} · TASK #${taskId}`}
          title={sourceTitle ?? td('untitled_source')}
          sourceLabel={t('source_label_prefix')}
          sourceUrl={sourceUrl}
          meta={heroMeta}
        />

        <Pipeline
          currentIdx={currentIdx >= 0 ? currentIdx : 0}
          failedIdx={-1}
          stepLabel={(k) => stepT(k)}
          statusLabels={{
            done: td('pipe_status_done'),
            current: td('pipe_status_current'),
            failed: td('pipe_status_failed'),
            pending: td('pipe_status_pending'),
          }}
          formatStepNum={(n, total) => td('pipe_step_num', { n, total })}
        />

        <ProcessingHero
          currentIdx={currentIdx}
          totalSteps={PIPELINE_STEPS.length}
          currentStepName={currentStepName}
          formatTitle={(step) => td('hero_title', { step })}
          flavorLines={flavorLines}
          formatEta={(percent) => td('eta', { percent })}
        />

        {tail.length > 0 && (
          <div
            style={{
              border: '1px solid var(--gp-border)',
              borderRadius: 'var(--gp-radius-md)',
              overflow: 'hidden',
              background: 'var(--gp-surface)',
            }}
          >
            <div
              style={{
                padding: '10px 14px',
                background: 'var(--gp-surface-raised)',
                fontSize: 12,
                display: 'flex',
                justifyContent: 'space-between',
                borderBottom: '1px solid var(--gp-border)',
              }}
            >
              <span>{td('log_title')}</span>
              {isPolling && (
                <span style={{ color: 'var(--gp-ink-faint)' }}>{td('log_refreshing')}</span>
              )}
            </div>
            <div
              style={{
                padding: '12px 14px',
                fontFamily: 'var(--gp-font-mono)',
                fontSize: 11.5,
                lineHeight: 1.7,
                color: 'var(--gp-ink-muted)',
                maxHeight: 260,
                overflowY: 'auto',
              }}
            >
              {tail.map((l) => (
                <div
                  key={l.id}
                  style={{ display: 'flex', gap: 10 }}
                  className={l.event === 'start' ? 'gp-log__entry--active' : ''}
                >
                  <span style={{ color: 'var(--gp-ink-faint)', flexShrink: 0 }}>
                    {formatTimeOfDay(l.timestamp, tz)}
                  </span>
                  <span>
                    {(() => {
                      try {
                        return stepT(l.step as PipelineStepKey);
                      } catch {
                        return l.step;
                      }
                    })()} · {td(`event_${l.event}`)}
                    {l.message ? ` — ${l.message}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {mobile && showDelete && (
          <MobileBar>
            <button
              type="button"
              className="gp-td-mobile-bar__btn gp-td-mobile-bar__btn--primary"
              onClick={() => setConfirmCancel(true)}
              disabled={isDeleting}
            >
              {isDeleting ? td('cancelling') : td('cancel_task')}
            </button>
          </MobileBar>
        )}
      </div>

      <ConfirmModal
        open={confirmCancel}
        title={td('confirm_cancel_title')}
        message={td('confirm_cancel_msg')}
        confirmLabel={td('cancel_task')}
        cancelLabel={td('cancel')}
        danger
        onConfirm={() => {
          setConfirmCancel(false);
          onCancel();
        }}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}
