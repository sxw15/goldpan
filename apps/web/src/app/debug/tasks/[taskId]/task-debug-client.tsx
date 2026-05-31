'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTz } from '@/components/tz-provider';
import { useCopyToClipboard } from '@/lib/clipboard';
import { formatTimeOfDay, formatTimeOfDayMs } from '@/lib/format';
import type { LogEvent } from '@/lib/task-display';
import { PIPELINE_MAIN_STEPS, STEP_INDEX } from '../../_pipeline';

const LLM_TO_PIPELINE_STEP: Record<string, string> = {
  classifier: 'classifying',
  extractor: 'extracting',
  matcher: 'matching',
  relator: 'relating',
  comparator: 'comparing',
  verifier: 'verifying',
  translator: 'translating',
};

interface TaskLogEntry {
  id: number;
  taskId: number;
  step: string;
  event: LogEvent;
  message: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
  timestamp: number;
}

interface LlmCallMeta {
  id: number;
  step: string;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  promptHash: string;
  sourceId: number | null;
  outcome?: string | null;
  failureKind?: string | null;
  failureMessage?: string | null;
  attemptNumber?: number | null;
  timestamp: number;
}

interface EventLogEntry {
  id: number;
  sourceId: number;
  entityId: number | null;
  pointId: number | null;
  action: string;
  timestamp: number;
  summary: string | null;
}

interface SubmissionLogEntry {
  id: number;
  rawInput: string;
  result: string;
  reason: string | null;
  taskId: number | null;
  sourceId: number | null;
  createdAt: number;
}

interface DebugSource {
  id: number;
  kind: 'external' | 'user';
  title: string | null;
  originalUrl: string | null;
  normalizedUrl: string | null;
  status: string;
  origin: string;
  rawContentPreview: string | null;
}

interface DebugDetail {
  task: {
    id: number;
    sourceId: number;
    status: string;
    pipelineStep: string | null;
    inputType: string | null;
    errorMessage: string | null;
    errorKind: string | null;
    createdAt: number;
    updatedAt: number;
  };
  source: DebugSource | null;
  logs: TaskLogEntry[];
  llmCalls: LlmCallMeta[];
  eventLogs: EventLogEntry[];
  submissionLogs: SubmissionLogEntry[];
}

type EventKind = 'log' | 'llm' | 'event' | 'submission';

interface NormalizedEvent {
  id: string;
  kind: EventKind;
  ts: number;
  step: string;
  // For sorting/filtering
  log?: TaskLogEntry;
  llm?: LlmCallMeta;
  ev?: EventLogEntry;
  sub?: SubmissionLogEntry;
}

interface Stage {
  step: string;
  ord: number | null;
  duration: number | null;
  startTs: number | null;
  endTs: number | null;
  llmCalls: number;
  retries: number;
  hasFailure: boolean;
  events: NormalizedEvent[];
}

function buildStages(detail: DebugDetail): Stage[] {
  const map = new Map<string, NormalizedEvent[]>();
  const ensure = (step: string) => {
    if (!map.has(step)) map.set(step, []);
    return map.get(step) as NormalizedEvent[];
  };

  for (const log of detail.logs) {
    ensure(log.step).push({
      id: `log-${log.id}`,
      kind: 'log',
      ts: log.timestamp,
      step: log.step,
      log,
    });
  }
  for (const call of detail.llmCalls) {
    const step = LLM_TO_PIPELINE_STEP[call.step] ?? call.step;
    ensure(step).push({
      id: `llm-${call.id}`,
      kind: 'llm',
      ts: call.timestamp,
      step,
      llm: call,
    });
  }
  for (const ev of detail.eventLogs) {
    ensure('storing').push({
      id: `ev-${ev.id}`,
      kind: 'event',
      ts: ev.timestamp,
      step: 'storing',
      ev,
    });
  }
  for (const sub of detail.submissionLogs) {
    ensure('storing').push({
      id: `sub-${sub.id}`,
      kind: 'submission',
      ts: sub.createdAt,
      step: 'storing',
      sub,
    });
  }

  const stages: Stage[] = [];
  for (const step of PIPELINE_MAIN_STEPS) {
    if (map.has(step)) {
      stages.push(toStage(step, map.get(step) as NormalizedEvent[]));
      map.delete(step);
    }
  }
  for (const [step, events] of map.entries()) {
    stages.push(toStage(step, events));
  }
  return stages;
}

function toStage(step: string, events: NormalizedEvent[]): Stage {
  events.sort((a, b) => a.ts - b.ts);
  let startTs: number | null = null;
  let endTs: number | null = null;
  let llmCalls = 0;
  let retries = 0;
  let hasFailure = false;
  for (const e of events) {
    if (e.kind === 'log' && e.log) {
      if (e.log.event === 'start' && startTs == null) startTs = e.log.timestamp;
      if (e.log.event === 'end') endTs = e.log.timestamp;
      if (e.log.event === 'error') hasFailure = true;
    }
    if (e.kind === 'llm' && e.llm) {
      llmCalls += 1;
      if ((e.llm.attemptNumber ?? 1) > 1) retries += 1;
    }
  }
  const startMs = startTs ?? (events.length ? events[0].ts : null);
  const endMs = endTs ?? (events.length ? events[events.length - 1].ts : null);
  const duration = startMs != null && endMs != null ? Math.max(0, (endMs - startMs) / 1000) : null;
  return {
    step,
    ord: STEP_INDEX[step] ?? null,
    duration,
    startTs,
    endTs,
    llmCalls,
    retries,
    hasFailure,
    events,
  };
}

function fmtSec(s: number | null, fallback = '—'): string {
  if (s == null) return fallback;
  if (s >= 100) return s.toFixed(0);
  if (s >= 10) return s.toFixed(1);
  return s.toFixed(2);
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function safeT(t: ReturnType<typeof useTranslations>, key: string): string {
  try {
    return t(key as never);
  } catch {
    return key;
  }
}

export function TaskDebugClient({ taskId }: { taskId: number }) {
  const t = useTranslations('debug');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const [detail, setDetail] = useState<DebugDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const fetchDetail = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      setError(null);
      if (mode === 'refresh') setRefreshError(null);
      try {
        const res = await fetch(`/api/debug/tasks/${taskId}`, { cache: 'no-store' });
        if (res.status === 401) {
          router.push('/login');
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setDetail((await res.json()) as DebugDetail);
      } catch {
        if (mode === 'initial') setError(t('load_error'));
        else setRefreshError(t('refresh_error'));
      } finally {
        if (mode === 'initial') setLoading(false);
        else setRefreshing(false);
      }
    },
    [taskId, t, router],
  );

  useEffect(() => {
    void fetchDetail('initial');
  }, [fetchDetail]);

  if (loading) {
    return (
      <div className="gpd-page">
        <Link href="/debug" className="gpd-task-back">
          ← {t('back')}
        </Link>
        <p className="gpd-load">{t('loading')}</p>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="gpd-page">
        <Link href="/debug" className="gpd-task-back">
          ← {t('back')}
        </Link>
        <p className="gpd-load gpd-load--err">{error ?? t('load_error')}</p>
        <p>
          <button type="button" className="gpd-btn" onClick={() => void fetchDetail('initial')}>
            {tCommon('retry')}
          </button>
        </p>
      </div>
    );
  }

  return (
    <DebugTaskView
      taskId={taskId}
      detail={detail}
      onRefresh={() => void fetchDetail('refresh')}
      refreshing={refreshing}
      refreshError={refreshError}
    />
  );
}

function DebugTaskView({
  taskId,
  detail,
  onRefresh,
  refreshing,
  refreshError,
}: {
  taskId: number;
  detail: DebugDetail;
  onRefresh: () => void;
  refreshing: boolean;
  refreshError: string | null;
}) {
  const t = useTranslations('debug');
  const tStatus = useTranslations('task.status');
  const tStep = useTranslations('debug.stage_label');

  const stages = useMemo(() => buildStages(detail), [detail]);

  const meta = useMemo(() => {
    const allTs = [
      ...detail.logs.map((l) => l.timestamp),
      ...detail.llmCalls.map((c) => c.timestamp),
      ...detail.eventLogs.map((e) => e.timestamp),
    ];
    const minTs = allTs.length ? Math.min(...allTs) : detail.task.createdAt;
    const maxTs = allTs.length ? Math.max(...allTs) : detail.task.updatedAt;
    const durationS = (maxTs - minTs) / 1000;
    const tokensIn = detail.llmCalls.reduce((a, c) => a + (c.inputTokens ?? 0), 0);
    const tokensOut = detail.llmCalls.reduce((a, c) => a + (c.outputTokens ?? 0), 0);
    const totalRetries = detail.llmCalls.filter((c) => (c.attemptNumber ?? 1) > 1).length;
    const kpCreated = detail.eventLogs.filter((e) => e.action === 'point_created').length;
    const entities = new Set(
      detail.eventLogs.filter((e) => e.entityId != null).map((e) => e.entityId),
    );
    return {
      duration: durationS,
      totalLlmCalls: detail.llmCalls.length,
      totalRetries,
      kpCreated,
      entitiesTouched: entities.size,
      tokensIn,
      tokensOut,
    };
  }, [detail]);

  const [view, setView] = useState<'timeline' | 'flame' | 'raw'>('timeline');
  // Raw view dumps the full DebugDetail (logs + llmCalls + eventLogs, often
  // hundreds of KB). Without memo, every parent state change (filter toggles,
  // refresh button) re-runs JSON.stringify on the entire payload.
  const rawJson = useMemo(
    () => (view === 'raw' ? JSON.stringify(detail, null, 2) : ''),
    [view, detail],
  );
  const [activeSteps, setActiveSteps] = useState<Set<string>>(
    () => new Set(stages.map((s) => s.step)),
  );
  const [eventTypes, setEventTypes] = useState<Set<string>>(new Set());
  const [sortAsc, setSortAsc] = useState(true);
  const [collapseStore, setCollapseStore] = useState(true);

  // Keep filters in sync if stages change after refresh
  useEffect(() => {
    setActiveSteps((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const s of stages) {
        if (!next.has(s.step)) {
          next.add(s.step);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [stages]);

  const status = detail.task.status;
  const statusLabel = safeT(tStatus, status === 'error' ? 'error' : status);
  const sourceTitle = detail.source?.title ?? null;
  const sourceUrl = detail.source?.originalUrl ?? null;
  const sourceTextPreview = detail.source?.kind === 'user' ? detail.source.rawContentPreview : null;

  const visibleStages = useMemo(() => {
    const ordered = stages.filter((s) => activeSteps.has(s.step));
    return sortAsc ? ordered : [...ordered].reverse();
  }, [stages, activeSteps, sortAsc]);

  const maxStageDuration = useMemo(
    () => Math.max(1, ...stages.map((x) => x.duration ?? 0)),
    [stages],
  );

  const totalEvents = visibleStages.reduce((a, s) => a + s.events.length, 0);

  const { copied: traceCopied, copy: copyTrace } = useCopyToClipboard();
  const [retrying, setRetrying] = useState(false);
  const [actionMessage, setActionMessage] = useState<{
    text: string;
    tone: 'ok' | 'err';
  } | null>(null);

  const handleCopyTrace = async () => {
    const ok = await copyTrace(JSON.stringify(detail, null, 2));
    if (!ok) setActionMessage({ text: t('action_copy_trace_failed'), tone: 'err' });
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `goldpan-task-${taskId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRetry = async () => {
    if (status !== 'error') {
      setActionMessage({ text: t('action_retry_only_failed'), tone: 'err' });
      return;
    }
    setRetrying(true);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/retry`, { method: 'POST' });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setActionMessage({ text: t('action_retry_started'), tone: 'ok' });
      onRefresh();
    } catch {
      setActionMessage({ text: t('action_retry_failed'), tone: 'err' });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="gpd-page">
      <Link href="/debug" className="gpd-task-back">
        ← {t('back')}
      </Link>

      <div className="gpd-task-hd">
        <div>
          <h1 className="gpd-task-hd__title">
            {t('task_header', { id: taskId })}
            <span className="gpd-task-hd__title-suffix">· {statusLabel}</span>
          </h1>
          {sourceTitle && <p className="gpd-task-hd__subtitle">{sourceTitle}</p>}
          {sourceTextPreview && !sourceTitle && (
            <p className="gpd-task-hd__subtitle">{sourceTextPreview}</p>
          )}
          {detail.task.errorMessage && status === 'error' && (
            <p className="gpd-task-hd__subtitle" style={{ color: 'var(--gp-badge-err-ink)' }}>
              {detail.task.errorKind ? `${detail.task.errorKind}: ` : ''}
              {detail.task.errorMessage}
            </p>
          )}
          {detail.task.pipelineStep && status === 'processing' && (
            <p className="gpd-task-hd__subtitle">
              {t('current_step')}: {safeT(tStep, detail.task.pipelineStep)}
            </p>
          )}
          {sourceUrl && (
            <a
              className="gpd-task-hd__src"
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              ⎘ {sourceUrl}
            </a>
          )}
        </div>
        <div className="gpd-task-hd__actions">
          <button type="button" className="gpd-btn" onClick={handleCopyTrace}>
            {traceCopied ? t('action_copy_trace_done') : t('action_copy_trace')}
          </button>
          <button type="button" className="gpd-btn" onClick={handleExportJson}>
            {t('action_export_json')}
          </button>
          {status === 'error' && (
            <button
              type="button"
              className="gpd-btn"
              onClick={handleRetry}
              disabled={retrying}
              aria-busy={retrying}
            >
              {retrying ? t('refreshing') : t('action_retry')}
            </button>
          )}
          <button
            type="button"
            className="gpd-btn"
            onClick={onRefresh}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            {refreshing ? t('refreshing') : t('refresh')}
          </button>
        </div>
      </div>
      {refreshError && <p className="gpd-toolbar__refresh-err">{refreshError}</p>}
      {actionMessage && (
        <p
          className="gpd-toolbar__refresh-err"
          style={actionMessage.tone === 'ok' ? { color: 'var(--gp-badge-done-ink)' } : undefined}
          role="status"
        >
          {actionMessage.text}
        </p>
      )}

      <div className="gpd-summary">
        <SummaryCell
          label={t('summary_duration')}
          value={fmtSec(meta.duration)}
          unit={t('unit_seconds')}
        />
        <SummaryCell
          label={t('summary_llm_calls')}
          value={String(meta.totalLlmCalls)}
          unit={t('unit_count')}
        />
        <SummaryCell
          label={t('summary_tokens')}
          value={`${fmtTokens(meta.tokensIn)} / ${fmtTokens(meta.tokensOut)}`}
        />
        <SummaryCell
          label={t('summary_retries')}
          value={String(meta.totalRetries)}
          unit={t('unit_count')}
          err={meta.totalRetries > 0}
        />
        <SummaryCell
          label={t('summary_kp_created')}
          value={String(meta.kpCreated)}
          unit={t('unit_count')}
        />
        <SummaryCell
          label={t('summary_entities_touched')}
          value={String(meta.entitiesTouched)}
          unit={t('unit_count')}
        />
      </div>

      <div className="gpd-view-tabs">
        <button
          type="button"
          className="gpd-view-tab"
          aria-pressed={view === 'timeline'}
          onClick={() => setView('timeline')}
        >
          {t('view_timeline')}
        </button>
        <button
          type="button"
          className="gpd-view-tab"
          aria-pressed={view === 'flame'}
          onClick={() => setView('flame')}
        >
          {t('view_flame')}
        </button>
        <button
          type="button"
          className="gpd-view-tab"
          aria-pressed={view === 'raw'}
          onClick={() => setView('raw')}
        >
          {t('view_raw')}
        </button>
      </div>

      {view === 'timeline' && (
        <>
          <FilterChips
            stages={stages}
            activeSteps={activeSteps}
            toggleStep={(s) =>
              setActiveSteps((prev) => {
                const next = new Set(prev);
                if (next.has(s)) next.delete(s);
                else next.add(s);
                return next;
              })
            }
            eventTypes={eventTypes}
            toggleType={(k) =>
              setEventTypes((prev) => {
                const next = new Set(prev);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                return next;
              })
            }
            sortAsc={sortAsc}
            setSortAsc={setSortAsc}
          />
          <div className="gpd-toolbar">
            <label className="gpd-toolbar__check">
              <input
                type="checkbox"
                checked={collapseStore}
                onChange={(e) => setCollapseStore(e.target.checked)}
              />
              {t('collapse_store_label')}
            </label>
            <span className="gpd-toolbar__count">
              {t('toolbar_count', {
                visible: visibleStages.length,
                total: stages.length,
                events: totalEvents,
              })}
            </span>
          </div>
          <div className="gpd-timeline">
            {visibleStages.length === 0 ? (
              <p className="gpd-load">{t('no_stages')}</p>
            ) : (
              visibleStages.map((s) => (
                <StageBlock
                  key={s.step}
                  stage={s}
                  maxDuration={maxStageDuration}
                  eventTypes={eventTypes}
                  collapseStore={collapseStore}
                />
              ))
            )}
          </div>
        </>
      )}
      {view === 'flame' && <Flamegraph stages={stages} totalDuration={meta.duration} />}
      {view === 'raw' && <pre className="gpd-raw">{rawJson}</pre>}
    </div>
  );
}

function SummaryCell({
  label,
  value,
  unit,
  err,
}: {
  label: string;
  value: string;
  unit?: string;
  err?: boolean;
}) {
  return (
    <div className="gpd-summary__cell">
      <div className="gpd-summary__label">{label}</div>
      <div className={`gpd-summary__value ${err ? 'gpd-summary__value--err' : ''}`}>
        {value}
        {unit && <small>{unit}</small>}
      </div>
    </div>
  );
}

function FilterChips({
  stages,
  activeSteps,
  toggleStep,
  eventTypes,
  toggleType,
  sortAsc,
  setSortAsc,
}: {
  stages: Stage[];
  activeSteps: Set<string>;
  toggleStep: (step: string) => void;
  eventTypes: Set<string>;
  toggleType: (k: string) => void;
  sortAsc: boolean;
  setSortAsc: (v: boolean) => void;
}) {
  const t = useTranslations('debug');
  const tStep = useTranslations('debug.stage_label');
  const typeOptions: [string, string][] = [
    ['log', t('chip_log')],
    ['llm', t('chip_llm')],
    ['event', t('chip_event')],
    ['retry', t('chip_retry_only')],
  ];
  return (
    <div className="gpd-filterbar">
      <span className="gpd-filterbar__label">{t('chip_stage')}</span>
      {stages.map((s) => (
        <button
          key={s.step}
          type="button"
          className="gpd-chip-toggle"
          aria-pressed={activeSteps.has(s.step)}
          onClick={() => toggleStep(s.step)}
        >
          {s.ord ? `${s.ord}. ` : ''}
          {safeT(tStep, s.step)}
          <span className="gpd-chip-toggle__num">{s.events.length}</span>
        </button>
      ))}
      <div className="gpd-filterbar__sep" />
      <span className="gpd-filterbar__label">{t('chip_type')}</span>
      {typeOptions.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="gpd-chip-toggle"
          aria-pressed={eventTypes.has(key)}
          onClick={() => toggleType(key)}
        >
          {label}
        </button>
      ))}
      <div className="gpd-filterbar__sep" />
      <button type="button" className="gpd-chip-toggle" onClick={() => setSortAsc(!sortAsc)}>
        {sortAsc ? t('sort_asc') : t('sort_desc')}
      </button>
    </div>
  );
}

function StageBlock({
  stage,
  maxDuration,
  eventTypes,
  collapseStore,
}: {
  stage: Stage;
  maxDuration: number;
  eventTypes: Set<string>;
  collapseStore: boolean;
}) {
  const t = useTranslations('debug');
  const tStep = useTranslations('debug.stage_label');
  const tz = useTz();
  const [collapsed, setCollapsed] = useState(false);

  const filtered = stage.events.filter((ev) => {
    if (eventTypes.size === 0) return true;
    if (eventTypes.has('retry') && ev.kind === 'llm' && (ev.llm?.attemptNumber ?? 1) > 1)
      return true;
    if (eventTypes.has('llm') && ev.kind === 'llm') return true;
    if (eventTypes.has('log') && ev.kind === 'log') return true;
    if (eventTypes.has('event') && (ev.kind === 'event' || ev.kind === 'submission')) return true;
    return false;
  });

  const displayed =
    collapseStore && stage.step === 'storing'
      ? collapseStoreEvents(filtered)
      : filtered.map((e) => ({ kind: 'single' as const, event: e, id: e.id }));

  const stageCls = stage.hasFailure
    ? 'gpd-stage--err'
    : stage.retries > 0
      ? 'gpd-stage--retry'
      : '';
  const pct = stage.duration != null ? Math.max(4, (stage.duration / maxDuration) * 100) : 0;
  const durationLabel = fmtSec(stage.duration);

  return (
    <div className={`gpd-stage ${stageCls}`} data-collapsed={collapsed}>
      <button
        type="button"
        className="gpd-stage__head"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
      >
        <div className="gpd-stage__ord">{stage.ord ?? '?'}</div>
        <div className="gpd-stage__title">
          <span className="gpd-stage__name">{safeT(tStep, stage.step)}</span>
          <span className="gpd-stage__step">{stage.step}</span>
          {stage.retries > 0 && (
            <span className="gpd-act gpd-act--retry">↻ {t('retry_n', { n: stage.retries })}</span>
          )}
          {stage.events.length > 8 && (
            <span className="gpd-act gpd-act--store">
              {t('event_count', { n: stage.events.length })}
            </span>
          )}
        </div>
        <div className="gpd-stage__meta">
          {stage.duration != null && (
            <div className="gpd-stage__bar">
              <div className="gpd-stage__bar-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
          <span>
            <b>{durationLabel}</b>
            {stage.duration != null && <span>s</span>}
          </span>
          {stage.llmCalls > 0 && (
            <span>
              <b>{stage.llmCalls}</b> LLM
            </span>
          )}
          {stage.startTs && stage.endTs && (
            <span>
              {formatTimeOfDay(stage.startTs, tz)} → {formatTimeOfDay(stage.endTs, tz)}
            </span>
          )}
          <span className="gpd-stage__caret">▾</span>
        </div>
      </button>
      <div className="gpd-stage__body">
        <div className="gpd-events">
          {displayed.length === 0 ? (
            <p className="gpd-load">{t('no_events_in_stage')}</p>
          ) : (
            displayed.map((row) =>
              row.kind === 'collapsed' ? (
                <CollapsedRow key={row.id} group={row} />
              ) : (
                <EventRow key={row.id} ev={row.event} />
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

type CollapsedGroup = {
  kind: 'collapsed';
  id: string;
  ts: number;
  count: number;
  kpCount: number;
  entCount: number;
  otherCount: number;
  children: NormalizedEvent[];
};

type DisplayRow = { kind: 'single'; id: string; event: NormalizedEvent } | CollapsedGroup;

function collapseStoreEvents(events: NormalizedEvent[]): DisplayRow[] {
  const result: DisplayRow[] = [];
  let buf: NormalizedEvent[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length >= 3) {
      const kpCount = buf.filter((e) => e.ev?.action === 'point_created').length;
      const entCount = buf.filter((e) => e.ev?.action === 'entity_created').length;
      const other = buf.length - kpCount - entCount;
      result.push({
        kind: 'collapsed',
        id: `collapsed-${buf[0].id}`,
        ts: buf[0].ts,
        count: buf.length,
        kpCount,
        entCount,
        otherCount: other,
        children: buf,
      });
    } else {
      for (const e of buf) result.push({ kind: 'single', id: e.id, event: e });
    }
    buf = [];
  };
  for (const e of events) {
    if (e.kind === 'event') {
      buf.push(e);
    } else {
      flush();
      result.push({ kind: 'single', id: e.id, event: e });
    }
  }
  flush();
  return result;
}

function CollapsedRow({ group }: { group: CollapsedGroup }) {
  const t = useTranslations('debug');
  const tz = useTz();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="gpd-collapsed"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="gpd-collapsed__ts">{formatTimeOfDay(group.ts, tz)}</span>
        <span className="gpd-collapsed__dot" />
        <span>
          <span className="gpd-collapsed__msg">
            {t.rich('collapsed_kp', {
              kp: group.kpCount,
              ent: group.entCount,
              other: group.otherCount,
              b: (chunks) => <b>{chunks}</b>,
            })}
          </span>
        </span>
        <span className="gpd-collapsed__caret">{open ? t('collapse') : t('expand')}</span>
      </button>
      {open && (
        <div className="gpd-collapsed__expanded">
          {group.children.map((e) => (
            <EventRow key={e.id} ev={e} />
          ))}
        </div>
      )}
    </>
  );
}

function EventRow({ ev }: { ev: NormalizedEvent }) {
  if (ev.kind === 'llm' && ev.llm) return <LlmEventRow call={ev.llm} />;
  if (ev.kind === 'log' && ev.log) return <LogEventRow log={ev.log} />;
  if (ev.kind === 'event' && ev.ev) return <StoreEventRow ev={ev.ev} />;
  if (ev.kind === 'submission' && ev.sub) return <SubmissionEventRow sub={ev.sub} />;
  return null;
}

function LogEventRow({ log }: { log: TaskLogEntry }) {
  const t = useTranslations('debug');
  const tLog = useTranslations('task_detail.log');
  const tz = useTz();
  const [expanded, setExpanded] = useState(false);
  const cls =
    log.event === 'start'
      ? 'gpd-event--start'
      : log.event === 'end'
        ? 'gpd-event--end'
        : log.event === 'error'
          ? 'gpd-event--llm-fail'
          : 'gpd-event--info';
  const actLabel = safeT(tLog, `event_${log.event}`);
  const actClass =
    log.event === 'start'
      ? 'gpd-act--start'
      : log.event === 'end'
        ? 'gpd-act--end'
        : log.event === 'error'
          ? 'gpd-act--llm-fail'
          : log.event === 'skip'
            ? 'gpd-act--skip'
            : 'gpd-act--start';
  const hasDetail = log.inputSummary || log.outputSummary || (log.event === 'error' && log.message);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access provided by the trailing "view details" <button>
    // biome-ignore lint/a11y/noStaticElementInteractions: same
    <div
      className={`gpd-event ${cls} ${hasDetail ? 'gpd-event--clickable' : ''}`}
      onClick={hasDetail ? () => setExpanded(!expanded) : undefined}
    >
      <div className="gpd-event__ts">{formatTimeOfDayMs(log.timestamp, tz)}</div>
      <div className="gpd-event__dot" />
      <div className="gpd-event__body">
        <div className="gpd-event__row">
          <span className={`gpd-act ${actClass}`}>{actLabel}</span>
          {log.message && <span className="gpd-event__msg">{log.message}</span>}
          {!log.message && log.event === 'start' && (
            <span className="gpd-event__msg">{t('log_start_default')}</span>
          )}
          {!log.message && log.event === 'end' && (
            <span className="gpd-event__msg">{t('log_end_default')}</span>
          )}
        </div>
        {log.outputSummary && !expanded && (
          <div className="gpd-event__sub">→ {truncate(log.outputSummary, 160)}</div>
        )}
        {expanded && (
          <div className="gpd-llm-body">
            {log.inputSummary && (
              <div className="gpd-llm-body__pane">
                <strong>{t('log_input')}</strong>
                {'\n'}
                {log.inputSummary}
              </div>
            )}
            {log.outputSummary && (
              <div className="gpd-llm-body__pane">
                <strong>{t('log_output')}</strong>
                {'\n'}
                {log.outputSummary}
              </div>
            )}
            {log.event === 'error' && log.message && (
              <div className="gpd-llm-body__pane gpd-llm-body__pane--err">{log.message}</div>
            )}
          </div>
        )}
      </div>
      {hasDetail && (
        <div className="gpd-event__action">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? t('collapse') : t('view_details')}
          </button>
        </div>
      )}
    </div>
  );
}

function LlmEventRow({ call }: { call: LlmCallMeta }) {
  const t = useTranslations('debug');
  const tz = useTz();
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<'input' | 'output' | 'meta'>('output');
  const [bodies, setBodies] = useState<{
    requestBody: string | null;
    responseBody: string | null;
    requestSchema: string | null;
  } | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);

  const failed = call.outcome === 'failed';
  const cls = failed ? 'gpd-event--llm-fail' : 'gpd-event--llm';
  const attempt = call.attemptNumber ?? 1;
  const totalTokens = (call.inputTokens ?? 0) + (call.outputTokens ?? 0);

  const handleToggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !bodies && !bodyLoading) {
      setBodyLoading(true);
      setBodyError(null);
      try {
        const res = await fetch(`/api/debug/llm-calls/${call.id}`);
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setBodies(await res.json());
      } catch {
        setBodyError(t('load_error'));
      } finally {
        setBodyLoading(false);
      }
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access provided by the trailing "view details" <button>
    // biome-ignore lint/a11y/noStaticElementInteractions: same
    <div className={`gpd-event ${cls} gpd-event--clickable`} onClick={handleToggle}>
      <div className="gpd-event__ts">{formatTimeOfDayMs(call.timestamp, tz)}</div>
      <div className="gpd-event__dot" />
      <div className="gpd-event__body">
        <div className="gpd-event__row">
          <span className={`gpd-act ${failed ? 'gpd-act--llm-fail' : 'gpd-act--llm'}`}>
            {failed ? t('llm_outcome_failed') : t('llm_call')}
          </span>
          {attempt > 1 && (
            <span className="gpd-act gpd-act--retry">{t('llm_attempt_n', { n: attempt })}</span>
          )}
          <div className="gpd-llm">
            {call.model && (
              <span className="gpd-llm__model">
                {call.provider ? `${call.provider}/` : ''}
                {call.model}
              </span>
            )}
            {(call.inputTokens != null || call.outputTokens != null) && (
              <span className="gpd-llm__tokens">
                <b>{call.inputTokens ?? 0}</b> in <em>·</em> <b>{call.outputTokens ?? 0}</b> out{' '}
                <em>·</em> <b>{totalTokens}</b> {t('tokens_unit')}
              </span>
            )}
          </div>
        </div>
        {failed && call.failureMessage && (
          <div className="gpd-event__sub gpd-event__sub--err">
            {call.failureKind ? `${call.failureKind}: ` : ''}
            {call.failureMessage}
          </div>
        )}
        {expanded && (
          // biome-ignore lint/a11y/useKeyWithClickEvents: nested button stops propagation; keyboard works via tab buttons
          // biome-ignore lint/a11y/noStaticElementInteractions: same
          <div className="gpd-llm-body" onClick={(e) => e.stopPropagation()}>
            <div className="gpd-llm-body__tabs">
              <button
                type="button"
                className="gpd-llm-body__tab"
                aria-pressed={tab === 'input'}
                onClick={() => setTab('input')}
              >
                {t('llm_tab_request')}
              </button>
              <button
                type="button"
                className="gpd-llm-body__tab"
                aria-pressed={tab === 'output'}
                onClick={() => setTab('output')}
              >
                {t('llm_tab_response')}
              </button>
              <button
                type="button"
                className="gpd-llm-body__tab"
                aria-pressed={tab === 'meta'}
                onClick={() => setTab('meta')}
              >
                {t('llm_tab_meta')}
              </button>
              {bodies && tab !== 'meta' && (
                <CopyButton payload={tab === 'input' ? bodies.requestBody : bodies.responseBody} />
              )}
            </div>
            {bodyLoading && (
              <div className="gpd-llm-body__pane gpd-llm-body__pane--loading">{t('loading')}</div>
            )}
            {bodyError && (
              <div className="gpd-llm-body__pane gpd-llm-body__pane--err">{bodyError}</div>
            )}
            {bodies && <LlmBodyPane tab={tab} bodies={bodies} call={call} failed={failed} />}
          </div>
        )}
      </div>
      <div className="gpd-event__action">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleToggle();
          }}
        >
          {expanded ? t('collapse') : t('view_details')}
        </button>
      </div>
    </div>
  );
}

function LlmBodyPane({
  tab,
  bodies,
  call,
  failed,
}: {
  tab: 'input' | 'output' | 'meta';
  bodies: { requestBody: string | null; responseBody: string | null; requestSchema: string | null };
  call: LlmCallMeta;
  failed: boolean;
}) {
  const t = useTranslations('debug');
  if (tab === 'input') {
    return (
      <div className="gpd-llm-body__pane">
        {bodies.requestBody ? prettyJson(bodies.requestBody) : t('no_body')}
        {bodies.requestSchema && (
          <>
            {'\n\n— '}
            {t('request_schema')}
            {' —\n'}
            {prettyJson(bodies.requestSchema)}
          </>
        )}
      </div>
    );
  }
  if (tab === 'output') {
    return (
      <div className={`gpd-llm-body__pane ${failed ? 'gpd-llm-body__pane--err' : ''}`}>
        {bodies.responseBody ? prettyJson(bodies.responseBody) : t('no_body')}
      </div>
    );
  }
  return (
    <div className="gpd-llm-body__pane">
      {JSON.stringify(
        {
          model: call.model,
          provider: call.provider,
          attempt: call.attemptNumber ?? 1,
          tokensIn: call.inputTokens,
          tokensOut: call.outputTokens,
          outcome: call.outcome ?? 'success',
          failureKind: call.failureKind ?? null,
          failureMessage: call.failureMessage ?? null,
        },
        null,
        2,
      )}
    </div>
  );
}

function CopyButton({ payload }: { payload: string | null }) {
  const t = useTranslations('debug');
  const { copied, copy } = useCopyToClipboard();
  if (!payload) return null;
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copy(payload);
  };
  return (
    <button type="button" className="gpd-llm-body__copy" onClick={handleCopy}>
      {copied ? t('copied') : t('copy')}
    </button>
  );
}

function StoreEventRow({ ev }: { ev: EventLogEntry }) {
  const tAction = useTranslations('debug.event_action');
  const tz = useTz();
  return (
    <div className="gpd-event gpd-event--store">
      <div className="gpd-event__ts">{formatTimeOfDayMs(ev.timestamp, tz)}</div>
      <div className="gpd-event__dot" />
      <div className="gpd-event__body">
        <div className="gpd-event__row">
          <span className="gpd-act gpd-act--store">{safeT(tAction, ev.action)}</span>
          {ev.summary && <span className="gpd-event__msg">{ev.summary}</span>}
        </div>
      </div>
    </div>
  );
}

function SubmissionEventRow({ sub }: { sub: SubmissionLogEntry }) {
  const tResult = useTranslations('debug.submission_result');
  const t = useTranslations('debug');
  const tz = useTz();
  const cls =
    sub.result === 'rejected'
      ? 'gpd-event--llm-fail'
      : sub.result === 'duplicate'
        ? 'gpd-event--info'
        : 'gpd-event--store';
  const actClass =
    sub.result === 'rejected'
      ? 'gpd-act--llm-fail'
      : sub.result === 'duplicate'
        ? 'gpd-act--skip'
        : 'gpd-act--store';
  return (
    <div className={`gpd-event ${cls}`}>
      <div className="gpd-event__ts">{formatTimeOfDayMs(sub.createdAt, tz)}</div>
      <div className="gpd-event__dot" />
      <div className="gpd-event__body">
        <div className="gpd-event__row">
          <span className={`gpd-act ${actClass}`}>{t('submission')}</span>
          <span className="gpd-event__msg">{safeT(tResult, sub.result)}</span>
        </div>
        {sub.reason && <div className="gpd-event__sub">{sub.reason}</div>}
      </div>
    </div>
  );
}

function Flamegraph({ stages, totalDuration }: { stages: Stage[]; totalDuration: number }) {
  const t = useTranslations('debug');
  const tStep = useTranslations('debug.stage_label');
  // Cache the derived rollups so view-tab toggles inside the parent don't
  // re-flatten / re-sort every render. `stages` is already useMemo'd upstream.
  const { stageMax, llmCalls, llmMax, totalLlm, totalRetries } = useMemo(() => {
    const tokensOf = (call: LlmCallMeta) => (call.inputTokens ?? 0) + (call.outputTokens ?? 0);
    const calls = stages.flatMap((s) =>
      s.events
        .filter((e) => e.kind === 'llm')
        .map((e) => ({ stageStep: s.step, call: e.llm as LlmCallMeta })),
    );
    const sortedCalls = calls
      .map((c) => ({ ...c, tokens: tokensOf(c.call) }))
      .sort((a, b) => b.tokens - a.tokens);
    return {
      stageMax: Math.max(0.001, ...stages.map((s) => s.duration ?? 0)),
      llmCalls: sortedCalls,
      llmMax: Math.max(1, ...sortedCalls.map((c) => c.tokens)),
      totalLlm: calls.length,
      totalRetries: calls.filter((c) => (c.call.attemptNumber ?? 1) > 1).length,
    };
  }, [stages]);

  return (
    <div className="gpd-flame">
      <div className="gpd-flame__hd">
        <span className="gpd-flame__title">{t('flame_title')}</span>
        <span className="gpd-flame__total">
          {t('flame_total', {
            duration: fmtSec(totalDuration),
            llm: totalLlm,
            retries: totalRetries,
          })}
        </span>
      </div>
      <div className="gpd-flame__sect-hd">{t('flame_by_stage')}</div>
      {stages.map((s) => {
        const w = s.duration != null ? Math.max(2, (s.duration / stageMax) * 100) : 0;
        const cls = s.hasFailure
          ? 'gpd-flame__bar-fill--err'
          : s.retries > 0
            ? 'gpd-flame__bar-fill--retry'
            : '';
        const pctTotal =
          s.duration != null && totalDuration > 0
            ? ((s.duration / totalDuration) * 100).toFixed(0)
            : '0';
        return (
          <div className="gpd-flame__row" key={s.step}>
            <span className="gpd-flame__lbl">
              {s.ord ? `${s.ord}. ` : ''}
              {safeT(tStep, s.step)} <small>{s.step}</small>
            </span>
            <div className="gpd-flame__bar">
              <div className={`gpd-flame__bar-fill ${cls}`} style={{ width: `${w}%` }}>
                {fmtSec(s.duration)}s
              </div>
            </div>
            <span className="gpd-flame__num">
              {s.llmCalls > 0 && (
                <>
                  {s.llmCalls} LLM <small>· </small>
                </>
              )}
              <small>{pctTotal}%</small>
            </span>
          </div>
        );
      })}
      {llmCalls.length > 0 && (
        <>
          <div className="gpd-flame__sect-hd">
            {t('flame_by_llm')}
            <small className="gpd-flame__sect-hint">{t('flame_by_llm_hint')}</small>
          </div>
          {llmCalls.map((c) => {
            const w = Math.max(6, (c.tokens / llmMax) * 100);
            const cls =
              c.call.outcome === 'failed'
                ? 'gpd-flame__bar-fill--err'
                : (c.call.attemptNumber ?? 1) > 1
                  ? 'gpd-flame__bar-fill--retry'
                  : 'gpd-flame__bar-fill--llm';
            const modelLabel = (c.call.model ?? '').split('/').pop() || '—';
            return (
              <div className="gpd-flame__row" key={`${c.call.id}-${c.stageStep}`}>
                <span className="gpd-flame__lbl">
                  {safeT(tStep, c.stageStep)}{' '}
                  <small>{t('attempt_n', { n: c.call.attemptNumber ?? 1 })}</small>
                </span>
                <div className="gpd-flame__bar">
                  <div className={`gpd-flame__bar-fill ${cls}`} style={{ width: `${w}%` }}>
                    {modelLabel}
                  </div>
                </div>
                <span className="gpd-flame__num">
                  {c.tokens.toLocaleString()}
                  <small> {t('tokens_unit')}</small>
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
