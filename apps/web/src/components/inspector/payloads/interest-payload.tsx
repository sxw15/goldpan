'use client';

import type { CreateInterestInput, UpdateInterestInput } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { useTz } from '@/components/tz-provider';
import { useFetchOnIdChange } from '@/hooks/use-fetch-on-id-change';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { formatDateMinute, freqDescriptor } from '@/lib/format';
import { StateError } from '../../state/state-error';
import { StateLoading } from '../../state/state-loading';
import { InterestForm } from '../../tracking/interest-form';
import type { InspectorPayload, PayloadAction, PayloadCapabilitySet } from './types';

const fetchInterest = (id: number, signal: AbortSignal) =>
  getBrowserApiClient().getInterest(id, signal);

interface InterestPayloadProps {
  id: number;
  onTitleReady: (title: string) => void;
  onNavigateEntity: (next: InspectorPayload) => void;
  onAction?: (action: PayloadAction) => Promise<void>;
  capabilities?: PayloadCapabilitySet;
  onDirtyChange?: (dirty: boolean) => void;
}

type Mode = 'readonly' | 'edit';
type DerivedStatus = 'running' | 'idle' | 'disabled' | 'failed';
type ExecutionStatus = 'running' | 'done' | 'error';

// Const lookups beat `t(\`status_dot_${x}\` as 'status_dot_running')`: the
// compiler sees real i18n keys, and `satisfies Record<...>` forces the map
// to track every variant when a new status is introduced.
const STATUS_DOT_KEY = {
  running: 'status_dot_running',
  idle: 'status_dot_idle',
  disabled: 'status_dot_disabled',
  failed: 'status_dot_failed',
} as const satisfies Record<DerivedStatus, string>;

const EXECUTION_STATUS_KEY = {
  running: 'execution_status_running',
  done: 'execution_status_done',
  error: 'execution_status_error',
} as const satisfies Record<ExecutionStatus, string>;

function deriveStatus(
  enabled: boolean,
  status: 'idle' | 'executing',
  hasError: boolean,
): DerivedStatus {
  if (!enabled) return 'disabled';
  if (status === 'executing') return 'running';
  if (hasError) return 'failed';
  return 'idle';
}

export function InterestPayload({
  id,
  onTitleReady,
  onNavigateEntity,
  onAction,
  capabilities,
  onDirtyChange,
}: InterestPayloadProps) {
  const canToggle = Boolean(onAction) && (capabilities?.has('setInterestEnabled') ?? false);
  const canEdit = Boolean(onAction) && (capabilities?.has('updateInterest') ?? false);
  const canDelete = Boolean(onAction) && (capabilities?.has('deleteInterest') ?? false);
  const canActSection = canEdit || canDelete;
  const t = useTranslations('interest_payload');
  // Frequency labels live in the `tracking` namespace so list + inspector
  // share one source.
  const tTrack = useTranslations('tracking');
  const tz = useTz();
  const [mode, setMode] = useState<Mode>('readonly');
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const { state, retry } = useFetchOnIdChange(id, fetchInterest, {
    retryKey,
    onReady: (d) => {
      onTitleReady(d.interest.name);
      setOptimisticEnabled(null);
    },
  });
  const detail = state.status === 'ready' ? state.data : null;

  useEffect(() => {
    onDirtyChange?.(formDirty);
    return () => {
      onDirtyChange?.(false);
    };
  }, [formDirty, onDirtyChange]);

  const effectiveEnabled = optimisticEnabled ?? detail?.interest.enabled ?? false;

  const handleToggleEnabled = useCallback(async () => {
    if (!onAction || !detail || toggling) return;
    const next = !effectiveEnabled;
    setToggling(true);
    setOptimisticEnabled(next);
    setActionError(null);
    try {
      await onAction({ type: 'setInterestEnabled', id, enabled: next });
    } catch (err) {
      setOptimisticEnabled(null);
      setActionError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setToggling(false);
    }
  }, [effectiveEnabled, onAction, id, detail, toggling]);

  const handleDelete = useCallback(async () => {
    if (!onAction) return;
    setActionError(null);
    try {
      await onAction({ type: 'deleteInterest', id });
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [onAction, id]);

  const handleEditSubmit = useCallback(
    async (patch: CreateInterestInput | UpdateInterestInput) => {
      if (!onAction) throw new Error('onAction missing');
      await onAction({ type: 'updateInterest', id, patch: patch as UpdateInterestInput });
      setMode('readonly');
      setFormDirty(false);
      setRetryKey((k) => k + 1);
    },
    [onAction, id],
  );

  const handleEditCancel = useCallback(() => {
    setMode('readonly');
    setFormDirty(false);
  }, []);

  if (state.status === 'error') return <StateError error={state.error} onRetry={retry} />;
  if (!detail) return <StateLoading />;

  const interest = detail.interest;
  const recentErr = detail.recentExecutions.find((e) => e.errorMessage);
  const status = deriveStatus(effectiveEnabled, interest.status, Boolean(recentErr));

  if (mode === 'edit') {
    return (
      <div className="gp-interest-payload gp-interest-payload--edit">
        <InterestForm
          mode="edit"
          initial={interest}
          onSubmit={handleEditSubmit}
          onCancel={handleEditCancel}
          onDirtyChange={setFormDirty}
        />
      </div>
    );
  }

  return (
    <div className="gp-interest-payload">
      {/* Description */}
      {interest.description ? (
        <p className="gp-interest-payload__description">{interest.description}</p>
      ) : (
        <p className="gp-interest-payload__description gp-interest-payload__description--empty">
          {t('description_placeholder')}
        </p>
      )}

      {/* Status meta row */}
      <div className="gp-track-insp-meta">
        <span className="gp-track-insp-meta__dot">
          <span
            className={`gp-rule-dot gp-rule-dot--${status}`}
            style={{ width: 7, height: 7 }}
            aria-hidden="true"
          />
          {t(STATUS_DOT_KEY[status])}
        </span>
        <span className="gp-track-insp-meta__when">
          {interest.nextRunAt
            ? t('next_run_label', { at: formatDateMinute(interest.nextRunAt, tz) })
            : t('next_run_paused')}
        </span>
      </div>

      {/* Last-execution error banner */}
      {recentErr?.errorMessage && (
        <div className="gp-track-warn" role="alert" style={{ marginBottom: 14, marginTop: -4 }}>
          <span className="gp-track-warn__icon gp-track-warn__icon--danger">!</span>
          <div className="gp-track-warn__body">
            <b>{t('last_run_failed')}</b>
            <div
              style={{
                fontFamily: 'var(--gp-font-mono)',
                fontSize: 11.5,
                marginTop: 4,
                wordBreak: 'break-word',
              }}
            >
              {recentErr.errorMessage}
            </div>
          </div>
        </div>
      )}

      {/* Keywords */}
      <div className="gp-interest-payload__section">
        <h4 className="gp-interest-payload__section-title">
          {t('queries_heading')}
          <b>· {interest.searchQueries.length}</b>
        </h4>
        <div className="gp-interest-payload__queries">
          {interest.searchQueries.map((q) => (
            <span key={q} className="gp-interest-payload__query-chip">
              {q}
            </span>
          ))}
        </div>
      </div>

      {/* Run config card + enable switch */}
      <div className="gp-interest-payload__section">
        <h4 className="gp-interest-payload__section-title">{t('run_config_heading')}</h4>
        <div className="gp-track-insp-card">
          <div className="gp-track-insp-card__row">
            <dt>{t('config_frequency_label')}</dt>
            <dd>
              {(() => {
                const f = freqDescriptor(interest.intervalMinutes);
                return f.n !== undefined ? tTrack(f.key, { n: f.n }) : tTrack(f.key);
              })()}
            </dd>
          </div>
          <div className="gp-track-insp-card__row">
            <dt>{t('config_last_run_label')}</dt>
            <dd>{interest.lastRunAt ? formatDateMinute(interest.lastRunAt, tz) : '—'}</dd>
          </div>
          <div className="gp-track-insp-card__row">
            <dt>{t('config_next_run_label')}</dt>
            <dd>{interest.nextRunAt ? formatDateMinute(interest.nextRunAt, tz) : '—'}</dd>
          </div>
          {canToggle && (
            <div className="gp-track-insp-card__row">
              <dt>{t('config_enabled_label')}</dt>
              <dd>
                <button
                  type="button"
                  role="switch"
                  aria-checked={effectiveEnabled}
                  aria-busy={toggling}
                  aria-label={t('enable_switch_label')}
                  disabled={toggling}
                  onClick={handleToggleEnabled}
                  className="gp-rule-row__toggle"
                />
              </dd>
            </div>
          )}
        </div>
      </div>

      {/* Linked entities */}
      {detail.linkedEntities.length > 0 && (
        <div className="gp-interest-payload__section">
          <h4 className="gp-interest-payload__section-title">
            {t('linked_entities_heading', { count: detail.linkedEntities.length })}
          </h4>
          <div className="gp-interest-payload__entity-chips">
            {detail.linkedEntities.map((e) => (
              <button
                key={e.id}
                type="button"
                className="gp-interest-payload__entity-chip"
                onClick={() => onNavigateEntity({ kind: 'entity', id: e.id })}
              >
                {e.name}
              </button>
            ))}
          </div>
          <p className="gp-interest-payload__hint">{t('linked_entities_hint')}</p>
        </div>
      )}

      {/* Recent executions */}
      <div className="gp-interest-payload__section">
        <h4 className="gp-interest-payload__section-title">
          {t('executions_heading')}
          <b>· {detail.recentExecutions.length}</b>
        </h4>
        {detail.recentExecutions.length === 0 ? (
          <p className="gp-interest-payload__executions-empty">
            {interest.enabled ? t('executions_empty_never_ran') : t('executions_empty_disabled')}
          </p>
        ) : (
          <ul className="gp-interest-payload__execution-list">
            {detail.recentExecutions.slice(0, 5).map((ex) => {
              const ok = ex.status !== 'error';
              return (
                <li key={ex.id} className={`gp-hit-run gp-hit-run--${ok ? 'ok' : 'err'}`}>
                  <div className="gp-hit-run__head">
                    <span className="gp-hit-run__time">{formatDateMinute(ex.startedAt, tz)}</span>
                    <span className="gp-hit-run__sum">
                      {t(EXECUTION_STATUS_KEY[ex.status])}
                      {' · '}
                      {t('execution_items_found', { n: ex.itemsFound })}
                      {' · '}
                      {t('execution_items_submitted', { n: ex.itemsSubmitted })}
                    </span>
                  </div>
                  {ex.errorMessage && <div className="gp-hit-run__error">{ex.errorMessage}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Footer actions */}
      {canActSection && (
        <div className="gp-interest-payload__actions">
          {canDelete && (
            <button
              type="button"
              className="gp-interest-payload__action-delete"
              onClick={handleDelete}
            >
              {t('action_delete')}
            </button>
          )}
          {canEdit && (
            <button type="button" onClick={() => setMode('edit')}>
              {t('action_edit')}
            </button>
          )}
        </div>
      )}
      {actionError && (
        <p role="alert" className="gp-interest-payload__action-error">
          {actionError.message}
        </p>
      )}
    </div>
  );
}
