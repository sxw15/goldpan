'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { ConfirmModal } from '@/components/confirm-modal';
import {
  type CollectingPluginDisplay,
  getCollectingPluginFromSummaries,
} from '@/lib/collecting-log-plugin';
import type { TaskLogEntry } from '@/lib/polling';
import { EVENT_I18N_KEY, type LogEvent } from '@/lib/task-display';

interface TaskLogPanelProps {
  logs: TaskLogEntry[];
  onClear?: () => void;
  isClearing?: boolean;
  defaultOpen?: boolean;
}

interface StepSummary {
  rowKey: string;
  step: string;
  event: LogEvent;
  startTime: number | null;
  endTime: number | null;
  durationMs: number | null;
  message: string | null;
  inputSummary: Record<string, unknown> | null;
  outputSummary: Record<string, unknown> | null;
}

function findLastIdx<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

function parseJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function computeStepSummaries(logs: TaskLogEntry[]): StepSummary[] {
  const steps: StepSummary[] = [];
  const startMap = new Map<string, number>();

  for (const log of logs) {
    if (log.event === 'start') {
      startMap.set(log.step, log.timestamp);
      steps.push({
        rowKey: `${log.step}-${log.timestamp}-${log.event}`,
        step: log.step,
        event: 'start',
        startTime: log.timestamp,
        endTime: null,
        durationMs: null,
        message: null,
        inputSummary: parseJson(log.inputSummary),
        outputSummary: null,
      });
    } else if (log.event === 'end') {
      const startTs = startMap.get(log.step);
      const durationMs = startTs != null ? log.timestamp - startTs : null;
      const idx = findLastIdx(steps, (s) => s.step === log.step && s.event === 'start');
      const inputSummary = idx >= 0 ? steps[idx].inputSummary : null;
      const entry: StepSummary = {
        rowKey: `${log.step}-${log.timestamp}-${log.event}`,
        step: log.step,
        event: 'end',
        startTime: startTs ?? null,
        endTime: log.timestamp,
        durationMs,
        message: null,
        inputSummary,
        outputSummary: parseJson(log.outputSummary),
      };
      if (idx >= 0) {
        steps[idx] = entry;
      } else {
        steps.push(entry);
      }
    } else if (log.event === 'error') {
      const startTs = startMap.get(log.step);
      const durationMs = startTs != null ? log.timestamp - startTs : null;
      const idx = findLastIdx(steps, (s) => s.step === log.step && s.event === 'start');
      const inputSummary = idx >= 0 ? steps[idx].inputSummary : null;
      const entry: StepSummary = {
        rowKey: `${log.step}-${log.timestamp}-${log.event}`,
        step: log.step,
        event: 'error',
        startTime: startTs ?? null,
        endTime: log.timestamp,
        durationMs,
        message: log.message,
        inputSummary,
        outputSummary: null,
      };
      if (idx >= 0) {
        steps[idx] = entry;
      } else {
        steps.push(entry);
      }
    } else if (log.event === 'skip') {
      steps.push({
        rowKey: `${log.step}-${log.timestamp}-${log.event}`,
        step: log.step,
        event: 'skip',
        startTime: null,
        endTime: null,
        durationMs: null,
        message: log.message,
        inputSummary: null,
        outputSummary: null,
      });
    }
  }

  return steps;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const remainder = s % 60;
  return `${m}m ${remainder.toFixed(0)}s`;
}

function CollectorPluginBadge({
  display,
  t,
}: {
  display: CollectingPluginDisplay | null;
  t: (key: string, values?: Record<string, string>) => string;
}) {
  if (!display) return null;
  if (display.kind === 'definitive') {
    return <span className="gp-log__plugin">{t('collector_plugin', { name: display.name })}</span>;
  }
  return (
    <span className="gp-log__plugin">
      {t('collector_plugin_candidates', { names: display.names })}
    </span>
  );
}

/** 实时计时：最小单位为整秒，不显示小数秒或毫秒 */
function formatDurationLive(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${m}m ${remainder}s`;
}

/** 已耗时达到该毫秒数后才显示实时计时，避免前几秒闪烁 */
const ACTIVE_DURATION_SHOW_AFTER_MS = 4000;

function ActiveDuration({ startTime }: { startTime: number | null }) {
  const [durationMs, setDurationMs] = useState<number | null>(null);

  useEffect(() => {
    if (startTime == null) return;

    const update = () => {
      setDurationMs(Math.max(0, Date.now() - startTime));
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  if (durationMs === null || durationMs < ACTIVE_DURATION_SHOW_AFTER_MS) return null;
  return <span className="gp-log__duration">{formatDurationLive(durationMs)}</span>;
}

export function TaskLogPanel({ logs, onClear, isClearing, defaultOpen = true }: TaskLogPanelProps) {
  const t = useTranslations('task_detail.log');
  const commonT = useTranslations('common');
  const pipelineStepT = useTranslations('task_detail.pipeline_step');

  const summaries = useMemo(() => computeStepSummaries(logs), [logs]);

  const [globalExpanded, setGlobalExpanded] = useState(defaultOpen);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(defaultOpen);

  const reversed = useMemo(() => [...summaries].reverse(), [summaries]);

  if (summaries.length === 0) {
    return null;
  }

  return (
    <div className={`gp-log ${!panelOpen ? 'gp-log--collapsed' : ''}`}>
      <div className="gp-log__topbar">
        <button
          type="button"
          className="gp-log__topbar-main"
          aria-expanded={panelOpen}
          aria-label={panelOpen ? t('hide_log') : t('show_log')}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          <div className="gp-log__topbar-header">
            <span
              className={`gp-log__toggle ${panelOpen ? 'gp-log__toggle--expanded' : ''}`}
              style={{ margin: 0, padding: 0 }}
              aria-hidden="true"
            >
              <ChevronRight size={16} />
            </span>
            <h3 className="gp-log__title">{t('title')}</h3>
          </div>
        </button>

        {panelOpen && (
          <div className="gp-log__topbar-actions">
            {onClear && (
              <button
                type="button"
                className="gp-btn gp-log__global-toggle"
                data-variant="ghost"
                onClick={() => setConfirmOpen(true)}
                disabled={isClearing}
              >
                {isClearing ? t('clearing') : t('clear')}
              </button>
            )}
            <button
              type="button"
              className="gp-btn gp-log__global-toggle"
              data-variant="ghost"
              onClick={() => setGlobalExpanded(!globalExpanded)}
            >
              {globalExpanded ? t('collapse_all') : t('expand_all')}
            </button>
          </div>
        )}
      </div>

      {panelOpen && (
        <div className="gp-log__list">
          {reversed.map((entry) => (
            <LogEntry
              key={entry.rowKey}
              entry={entry}
              pipelineStepT={pipelineStepT}
              t={t}
              globalExpanded={globalExpanded}
            />
          ))}
        </div>
      )}
      {onClear && (
        <ConfirmModal
          open={confirmOpen}
          title={t('clear_confirm_title')}
          message={t('clear_confirm_message')}
          confirmLabel={t('clear')}
          cancelLabel={commonT('cancel')}
          danger
          onConfirm={() => {
            setConfirmOpen(false);
            onClear();
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

function LogEntry({
  entry,
  pipelineStepT,
  t,
  globalExpanded,
}: {
  entry: StepSummary;
  pipelineStepT: (key: string) => string;
  t: (key: string) => string;
  globalExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(globalExpanded);

  useEffect(() => {
    setExpanded(globalExpanded);
  }, [globalExpanded]);

  const stepLabel = tryTranslateStep(pipelineStepT, entry.step);
  const collectingPlugin = getCollectingPluginFromSummaries({
    step: entry.step,
    inputSummary: entry.inputSummary,
    outputSummary: entry.outputSummary,
  });
  const isActive = entry.event === 'start';
  const isError = entry.event === 'error';
  const isSkip = entry.event === 'skip';
  const hasDetails = entry.inputSummary || entry.outputSummary || entry.message;

  return (
    <div
      className={`gp-log__entry${isActive ? ' gp-log__entry--active' : ''}${isError ? ' gp-log__entry--error' : ''}${isSkip ? ' gp-log__entry--skip' : ''}`}
    >
      <div className="gp-log__dot" />
      <div className="gp-log__content">
        {hasDetails ? (
          <button
            type="button"
            className="gp-log__header gp-log__header--clickable"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            <span className="gp-log__step">{stepLabel}</span>
            <span className="gp-log__event">{t(EVENT_I18N_KEY[entry.event])}</span>
            <CollectorPluginBadge display={collectingPlugin} t={t} />
            {entry.durationMs != null ? (
              <span className="gp-log__duration">{formatDuration(entry.durationMs)}</span>
            ) : isActive && entry.startTime ? (
              <ActiveDuration startTime={entry.startTime} />
            ) : null}
            {isActive && <span className="gp-log__pulse" />}
            <span className={`gp-log__toggle ${expanded ? 'gp-log__toggle--expanded' : ''}`}>
              <ChevronRight size={16} />
            </span>
          </button>
        ) : (
          <div className="gp-log__header">
            <span className="gp-log__step">{stepLabel}</span>
            <span className="gp-log__event">{t(EVENT_I18N_KEY[entry.event])}</span>
            <CollectorPluginBadge display={collectingPlugin} t={t} />
            {entry.durationMs != null ? (
              <span className="gp-log__duration">{formatDuration(entry.durationMs)}</span>
            ) : isActive && entry.startTime ? (
              <ActiveDuration startTime={entry.startTime} />
            ) : null}
            {isActive && <span className="gp-log__pulse" />}
          </div>
        )}
        {entry.message && <div className="gp-log__message">{entry.message}</div>}
        {expanded && (
          <div className="gp-log__details">
            {entry.inputSummary && <SummaryBlock label={t('input')} data={entry.inputSummary} />}
            {entry.outputSummary && <SummaryBlock label={t('output')} data={entry.outputSummary} />}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryBlock({ label, data }: { label: string; data: Record<string, unknown> }) {
  return (
    <div className="gp-log__summary">
      <span className="gp-log__summary-label">{label}</span>
      <div className="gp-log__summary-body">
        {Object.entries(data).map(([key, value]) => (
          <SummaryField key={key} name={key} value={value} />
        ))}
      </div>
    </div>
  );
}

function SummaryField({ name, value }: { name: string; value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    // Array of objects (e.g. points, entities)
    if (typeof value[0] === 'object' && value[0] !== null) {
      return (
        <div className="gp-log__field">
          <span className="gp-log__field-name">{name}</span>
          <div className="gp-log__field-list">
            {value.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: log field items have no stable unique key
              <span key={`${name}:${i}`} className="gp-log__field-item">
                {typeof item === 'object'
                  ? formatCompact(item as Record<string, unknown>)
                  : String(item)}
              </span>
            ))}
          </div>
        </div>
      );
    }
    // Array of primitives (e.g. keywords)
    return (
      <div className="gp-log__field">
        <span className="gp-log__field-name">{name}</span>
        <span className="gp-log__field-value">{value.join(', ')}</span>
      </div>
    );
  }

  if (value === null || value === undefined) return null;

  const display =
    typeof value === 'object' ? formatCompact(value as Record<string, unknown>) : String(value);

  return (
    <div className="gp-log__field">
      <span className="gp-log__field-name">{name}</span>
      <span className="gp-log__field-value">{display}</span>
    </div>
  );
}

function formatCompact(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    if (typeof val === 'string' && val.length > 60) {
      parts.push(`${key}: ${val.slice(0, 60)}...`);
    } else {
      parts.push(`${key}: ${String(val)}`);
    }
  }
  return parts.join(' | ');
}

function tryTranslateStep(t: (key: string) => string, step: string): string {
  try {
    return t(step);
  } catch {
    return step;
  }
}
