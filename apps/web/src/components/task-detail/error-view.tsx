'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ConfirmModal } from '@/components/confirm-modal';
import type { ToastInput } from '@/components/toast-stack';
import { useTz } from '@/components/tz-provider';
import { Hero } from '@/components/ui/hero';
import { copyToClipboard } from '@/lib/clipboard';
import { ErrorCard } from './error-card';
import { MobileBar } from './mobile-bar';
import { Pipeline, type PipelineStepKey, pipelineIndexOf } from './pipeline';
import { StickyBar } from './sticky-bar';

export interface ErrorViewProps {
  taskId: number;
  sourceUrl: string | null;
  createdAt: number | null;
  sourceTitle: string | null;
  sourceKindLabel: string;
  /** Step name where pipeline failed (raw key like "extracting"). */
  failedStep: string | null;
  /** Friendly error message. */
  errorMessage: string;
  /** Server error kind (e.g. "content_policy") — drives per-kind recovery advice. */
  errorKind: string | null;
  /** Whether retrying could plausibly succeed. When false, retry affordances are
   * hidden — re-running won't change the outcome (e.g. a content-policy block). */
  retryable: boolean;
  /** When non-null shows debug log block. */
  technicalLog?: string | null;
  isRetrying: boolean;
  isDeleting: boolean;
  showDelete: boolean;
  onRetry: () => void;
  onDelete: () => void;
  toast: (t: ToastInput) => void;
  mobile?: boolean;
}

export function ErrorView({
  taskId,
  sourceUrl,
  createdAt,
  sourceTitle,
  sourceKindLabel,
  failedStep,
  errorMessage,
  errorKind,
  retryable,
  technicalLog,
  isRetrying,
  isDeleting,
  showDelete,
  onRetry,
  onDelete,
  toast,
  mobile,
}: ErrorViewProps) {
  const t = useTranslations('task_detail');
  const td = useTranslations('task_detail.error');
  const tStatus = useTranslations('task.status');
  const stepT = useTranslations('task_detail.pipeline_step');
  const tz = useTz();
  const locale = useLocale();

  const [confirmDelete, setConfirmDelete] = useState(false);

  const failedIdx = pipelineIndexOf(failedStep);
  const failedStepName =
    failedIdx >= 0 ? stepT(failedStep as PipelineStepKey) : (failedStep ?? td('unknown_step'));

  const heroMeta: Array<{ label: string; value: string }> = [];
  if (createdAt != null)
    heroMeta.push({
      label: td('meta_created'),
      value: new Date(createdAt).toLocaleString(locale, { timeZone: tz }),
    });
  if (sourceKindLabel) heroMeta.push({ label: td('meta_source'), value: sourceKindLabel });

  // Recovery advice tailored to the error kind. content_policy is non-retryable
  // (retry button hidden), so its advice drops the misleading "just retry" line.
  // content_length IS retryable — its min/max limits are user-configurable
  // (Settings → 采集 · 内容长度) so a re-run after adjusting them succeeds — its
  // advice leads with trim/expand-or-adjust-limits guidance, retry button shown.
  const adviceLines: string[] = [];
  if (errorKind === 'content_policy') {
    adviceLines.push(td('card_hint_content_policy'));
  } else if (errorKind === 'content_length') {
    // Just the length-specific guidance — NOT card_hint_text ("resubmit a
    // plain-text excerpt"), which is wrong for the too-short case and redundant
    // for too-long (card_hint_content_length already covers trim/expand/adjust).
    adviceLines.push(td('card_hint_content_length'));
  } else if (retryable) {
    adviceLines.push(td('card_hint_retry'));
    adviceLines.push(td('card_hint_text'));
  } else {
    adviceLines.push(td('card_hint_nonretryable'));
  }
  adviceLines.push(td('card_hint_support', { taskId }));

  const handleCopyError = async () => {
    const text = `Task #${taskId}\nStep: ${failedStepName}\nError: ${errorMessage}${
      technicalLog ? `\n\n${technicalLog}` : ''
    }`;
    const ok = await copyToClipboard(text);
    toast({
      msg: ok ? td('toast_copied_error') : td('toast_copy_failed'),
      kind: ok ? 'success' : 'danger',
    });
  };

  return (
    <div className={`gp-td-page${mobile ? ' gp-td-page--mobile' : ''}`}>
      <StickyBar
        status="error"
        taskId={taskId}
        backHref="/library"
        backLabel={td('back')}
        taskCrumbLabel={td('crumb_task')}
        statusLabel={tStatus('error')}
        primaryMetric={
          failedIdx >= 0
            ? td.rich('sticky_metric', {
                step: failedStepName,
                b: (ch) => <b>{ch}</b>,
              })
            : null
        }
        primaryAction={
          mobile || !retryable ? null : (
            <button
              type="button"
              className="gp-btn"
              data-variant="primary"
              onClick={onRetry}
              disabled={isRetrying}
            >
              ↻ {isRetrying ? td('retrying') : td('retry')}
            </button>
          )
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

        {failedIdx >= 0 && (
          <Pipeline
            currentIdx={-1}
            failedIdx={failedIdx}
            stepLabel={(k) => stepT(k)}
            statusLabels={{
              done: td('pipe_status_done'),
              current: td('pipe_status_current'),
              failed: td('pipe_status_failed'),
              pending: td('pipe_status_pending'),
            }}
            formatStepNum={(n, total) => td('pipe_step_num', { n, total })}
          />
        )}

        <ErrorCard
          title={td('card_title')}
          message={errorMessage}
          hint={
            <>
              <b>{td('card_hint_intro')}</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: '1.1rem' }}>
                {adviceLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          }
          primaryCta={
            retryable ? (
              <button
                type="button"
                className="gp-btn"
                data-variant="primary"
                onClick={onRetry}
                disabled={isRetrying}
              >
                ↻ {isRetrying ? td('retrying') : td('retry')}
              </button>
            ) : null
          }
          secondaryCtas={
            <button
              type="button"
              className="gp-btn"
              data-variant="secondary"
              onClick={handleCopyError}
            >
              {td('copy_error')}
            </button>
          }
          endCta={
            showDelete ? (
              <button
                type="button"
                className="gp-btn"
                data-variant="danger"
                onClick={() => setConfirmDelete(true)}
                disabled={isDeleting}
              >
                {isDeleting ? td('deleting') : td('delete_task')}
              </button>
            ) : null
          }
        />

        {technicalLog && (
          <details className="gp-log" open>
            <summary
              style={{
                padding: '10px 14px',
                background: 'var(--gp-surface-raised)',
                fontSize: 12,
                cursor: 'pointer',
                listStyle: 'none',
                borderRadius: 'var(--gp-radius-sm)',
                border: '1px solid var(--gp-border)',
              }}
            >
              {td('technical_log_title')}
            </summary>
            <pre
              style={{
                margin: 0,
                padding: '12px 14px',
                fontFamily: 'var(--gp-font-mono)',
                fontSize: 12,
                color: 'var(--gp-ink-muted)',
                background: 'var(--gp-bg)',
                whiteSpace: 'pre-wrap',
                borderRadius: '0 0 var(--gp-radius-sm) var(--gp-radius-sm)',
                border: '1px solid var(--gp-border)',
                borderTop: 'none',
              }}
            >
              {technicalLog}
            </pre>
          </details>
        )}

        {mobile && (
          <MobileBar>
            {retryable && (
              <button
                type="button"
                className="gp-td-mobile-bar__btn gp-td-mobile-bar__btn--primary"
                onClick={onRetry}
                disabled={isRetrying}
              >
                ↻ {isRetrying ? td('retrying') : td('retry')}
              </button>
            )}
            <button type="button" className="gp-td-mobile-bar__btn" onClick={handleCopyError}>
              {td('copy_error_short')}
            </button>
          </MobileBar>
        )}
      </div>

      <ConfirmModal
        open={confirmDelete}
        title={td('confirm_delete_title')}
        message={td('confirm_delete_msg')}
        confirmLabel={td('delete_task')}
        cancelLabel={td('cancel')}
        danger
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
