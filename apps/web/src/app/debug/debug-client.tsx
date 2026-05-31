'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTz } from '@/components/tz-provider';
import { useVisibilityAwarePolling } from '@/hooks/use-visibility-aware-polling';
import type { TaskSummary } from '@/types/task';
import { PIPELINE_TOTAL, STEP_INDEX } from './_pipeline';

const POLL_INTERVAL_MS = 30_000;

type StatusFilter = 'all' | 'done' | 'processing' | 'error';
type KindFilter = 'all' | 'user' | 'external' | 'tracking';
type RangeFilter = '1h' | '24h' | '7d' | 'all';

const RANGE_MS: Record<RangeFilter, number | null> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  all: null,
};

// Skip rerender when the polled list is unchanged — without this, every
// 30s tick invalidates downstream useMemos and re-renders the whole 50-row list.
function tasksUnchanged(prev: TaskSummary[], next: TaskSummary[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.pipelineStep !== b.pipelineStep ||
      a.errorKind !== b.errorKind ||
      a.retryCount !== b.retryCount ||
      a.llmCount !== b.llmCount ||
      a.durationS !== b.durationS
    ) {
      return false;
    }
  }
  return true;
}

function classifyKind(t: TaskSummary): KindFilter {
  if (!t.source) return 'user';
  if (t.source.origin === 'tracking') return 'tracking';
  if (t.source.kind === 'user') return 'user';
  return 'external';
}

function stepProgress(t: TaskSummary): string {
  if (t.status === 'done') return `${PIPELINE_TOTAL}/${PIPELINE_TOTAL}`;
  if (t.status === 'pending') return `0/${PIPELINE_TOTAL}`;
  const step = t.pipelineStep ?? '';
  const idx = STEP_INDEX[step];
  return idx ? `${idx}/${PIPELINE_TOTAL}` : `—/${PIPELINE_TOTAL}`;
}

function fmtDuration(s: number | null): string {
  if (s == null) return '—';
  if (s >= 100) return `${s.toFixed(0)}s`;
  if (s >= 10) return `${s.toFixed(1)}s`;
  return `${s.toFixed(2)}s`;
}

function formatDateShort(ms: number, tz: string): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  // "Same day" comparison must use the same tz used to render the row, otherwise
  // a row created today UTC+0 might render as date-stamped while tz=Asia/Tokyo
  // shows just the time (or vice versa).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const sameDay = fmt.format(d) === fmt.format(new Date());
  const time = d.toLocaleTimeString(undefined, {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { timeZone: tz, month: '2-digit', day: '2-digit' })} ${time}`;
}

export function DebugClient({ initialTasks }: { initialTasks: TaskSummary[] }) {
  const t = useTranslations('debug');
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskSummary[]>(initialTasks);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [range, setRange] = useState<RangeFilter>('24h');
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?limit=50', { cache: 'no-store' });
      if (res.status === 401) {
        router.push('/login');
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as { data: TaskSummary[] };
      setTasks((prev) => (tasksUnchanged(prev, body.data) ? prev : body.data));
    } catch {
      // Silent: a single missed tick is fine, the next will retry.
    }
  }, [router]);

  useVisibilityAwarePolling(fetchTasks, POLL_INTERVAL_MS);

  // `/` focuses the search input (matches the prototype's kbd hint).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const inRange = useMemo(() => {
    const cutoffMs = RANGE_MS[range];
    if (cutoffMs == null) return tasks;
    const cutoff = Date.now() - cutoffMs;
    return tasks.filter((x) => x.createdAt >= cutoff);
  }, [tasks, range]);

  const counts = useMemo(() => {
    return {
      total: inRange.length,
      done: inRange.filter((x) => x.status === 'done').length,
      proc: inRange.filter((x) => x.status === 'processing').length,
      err: inRange.filter((x) => x.status === 'error').length,
    };
  }, [inRange]);

  const stats24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const within = tasks.filter((x) => x.createdAt >= cutoff);
    const done = within.filter((x) => x.status === 'done').length;
    const proc = within.filter((x) => x.status === 'processing').length;
    const err = within.filter((x) => x.status === 'error').length;
    return { tasks: within.length, done, processing: proc, errors: err };
  }, [tasks]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return inRange.filter((task) => {
      if (status !== 'all' && task.status !== status) return false;
      if (kind !== 'all' && classifyKind(task) !== kind) return false;
      if (ql) {
        const hay = [
          String(task.id),
          task.source?.title ?? '',
          task.source?.originalUrl ?? '',
          task.source?.rawContentPreview ?? '',
          task.pipelineStep ?? '',
          task.errorKind ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [inRange, status, kind, q]);

  return (
    <div className="gpd-page">
      <div className="gpd-hero">
        <div>
          <h1>{t('title')}</h1>
          <p>{t('subtitle')}</p>
        </div>
        <span className="gpd-hero__live">{t('hero_live')}</span>
      </div>

      <div className="gpd-stats">
        <div className="gpd-stat">
          <div className="gpd-stat__label">{t('stat_24h_tasks')}</div>
          <div className="gpd-stat__value">
            {stats24h.tasks}
            <small>{t('unit_count')}</small>
          </div>
        </div>
        <div className="gpd-stat gpd-stat--err">
          <div className="gpd-stat__label">{t('stat_failed')}</div>
          <div className="gpd-stat__value">
            {stats24h.errors}
            <small>{t('unit_count')}</small>
          </div>
        </div>
        <div className="gpd-stat gpd-stat--proc">
          <div className="gpd-stat__label">{t('stat_processing')}</div>
          <div className="gpd-stat__value">
            {stats24h.processing}
            <small>{t('unit_count')}</small>
          </div>
        </div>
        <div className="gpd-stat">
          <div className="gpd-stat__label">{t('stat_done')}</div>
          <div className="gpd-stat__value">
            {stats24h.done}
            <small>{t('unit_count')}</small>
          </div>
        </div>
      </div>

      <div className="gpd-filters">
        <div className="gpd-search">
          <span className="gpd-search__icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={searchRef}
            placeholder={t('search_placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label={t('search_placeholder')}
          />
          <kbd>/</kbd>
        </div>
        <div className="gpd-seg">
          <button
            type="button"
            aria-pressed={status === 'all'}
            onClick={() => setStatus('all')}
            className="gpd-seg__btn"
          >
            {t('filter_all')} <small>{counts.total}</small>
          </button>
          <button
            type="button"
            aria-pressed={status === 'done'}
            onClick={() => setStatus('done')}
            className="gpd-seg__btn"
          >
            {t('filter_done')} <small>{counts.done}</small>
          </button>
          <button
            type="button"
            aria-pressed={status === 'processing'}
            onClick={() => setStatus('processing')}
            className="gpd-seg__btn"
          >
            {t('filter_processing')} <small>{counts.proc}</small>
          </button>
          <button
            type="button"
            aria-pressed={status === 'error'}
            onClick={() => setStatus('error')}
            className="gpd-seg__btn"
          >
            {t('filter_failed')} <small>{counts.err}</small>
          </button>
        </div>
        <div className="gpd-seg">
          <button
            type="button"
            aria-pressed={kind === 'all'}
            onClick={() => setKind('all')}
            className="gpd-seg__btn"
          >
            {t('kind_all')}
          </button>
          <button
            type="button"
            aria-pressed={kind === 'user'}
            onClick={() => setKind('user')}
            className="gpd-seg__btn"
          >
            {t('kind_user_source')}
          </button>
          <button
            type="button"
            aria-pressed={kind === 'external'}
            onClick={() => setKind('external')}
            className="gpd-seg__btn"
          >
            {t('kind_external')}
          </button>
          <button
            type="button"
            aria-pressed={kind === 'tracking'}
            onClick={() => setKind('tracking')}
            className="gpd-seg__btn"
          >
            {t('kind_tracking')}
          </button>
        </div>
        <div className="gpd-seg">
          {(['1h', '24h', '7d', 'all'] as RangeFilter[]).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className="gpd-seg__btn"
            >
              {t(`range_${r}`)}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty hasAnyTasks={tasks.length > 0} />
      ) : (
        <ListBody tasks={filtered} />
      )}
    </div>
  );
}

function ListBody({ tasks }: { tasks: TaskSummary[] }) {
  const t = useTranslations('debug');
  const tStatus = useTranslations('task.status');
  const tz = useTz();

  return (
    <div className="gpd-list">
      <div className="gpd-list__head">
        <span>{t('col_id')}</span>
        <span>{t('col_status')}</span>
        <span>{t('col_input')}</span>
        <span style={{ textAlign: 'right' }}>{t('col_duration')}</span>
        <span style={{ textAlign: 'right' }}>{t('col_steps')}</span>
        <span style={{ textAlign: 'right' }}>{t('col_llm')}</span>
        <span style={{ textAlign: 'right' }}>{t('col_retry')}</span>
        <span style={{ textAlign: 'right' }}>{t('col_time')}</span>
        <span aria-hidden="true" />
      </div>
      {tasks.map((task) => {
        const cls =
          task.status === 'error'
            ? 'gpd-row--err'
            : task.status === 'processing'
              ? 'gpd-row--proc'
              : '';
        const sourceTitle =
          task.source?.title ||
          task.source?.originalUrl ||
          task.source?.rawContentPreview ||
          t('text_input');
        const isText = !task.source?.originalUrl && !task.source?.title;
        const inputDetail =
          task.source?.originalUrl || (task.source?.kind === 'user' ? t('input_detail_text') : '');
        return (
          <Link key={task.id} href={`/debug/tasks/${task.id}`} className={`gpd-row ${cls}`}>
            <div className="gpd-row__id">#{task.id}</div>
            <div>
              <span className={`gpd-status gpd-status--${task.status}`}>
                {tStatus(task.status)}
              </span>
            </div>
            <div className={`gpd-row__input ${isText ? 'gpd-row__input--placeholder' : ''}`}>
              {sourceTitle}
              {inputDetail && <small>{inputDetail}</small>}
              {task.errorKind && <span className="gpd-row__err">⚠ {task.errorKind}</span>}
              {task.status === 'processing' && task.pipelineStep && (
                <span className="gpd-row__progress">▸ {task.pipelineStep}</span>
              )}
            </div>
            <div className={`gpd-row__num ${task.durationS == null ? 'gpd-row__num--zero' : ''}`}>
              {fmtDuration(task.durationS)}
            </div>
            <div className="gpd-row__num">{stepProgress(task)}</div>
            <div className={`gpd-row__num ${task.llmCount === 0 ? 'gpd-row__num--zero' : ''}`}>
              {task.llmCount > 0 ? task.llmCount : '—'}
            </div>
            <div
              className={`gpd-row__num ${
                task.retryCount === 0 ? 'gpd-row__num--zero' : 'gpd-row__num--retry'
              }`}
            >
              {task.retryCount > 0 ? task.retryCount : '—'}
            </div>
            <div className="gpd-row__date">{formatDateShort(task.createdAt, tz)}</div>
            <div className="gpd-row__chev" aria-hidden="true">
              ▸
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function Empty({ hasAnyTasks }: { hasAnyTasks: boolean }) {
  const t = useTranslations('debug');
  return (
    <div className="gpd-empty">
      <div className="gpd-empty__icon">∅</div>
      <div className="gpd-empty__title">
        {hasAnyTasks ? t('empty_filtered_title') : t('empty_title')}
      </div>
      <div className="gpd-empty__hint">
        {hasAnyTasks
          ? t('empty_filtered_hint')
          : t.rich('empty_hint', { code: (c) => <code>{c}</code> })}
      </div>
    </div>
  );
}
