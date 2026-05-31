import type { Task } from '@goldpan/web-sdk';

const URL_DISPLAY_LIMIT = 40;

/** Source origin values the UI knows how to localize (i18n key per value).
 *  Anything not in this set falls back to rendering the raw origin string —
 *  the API may surface a new origin before the UI ships a translation. */
export const KNOWN_SOURCE_ORIGINS = ['user', 'tracking', 'github_refresh'] as const;
export type KnownSourceOrigin = (typeof KNOWN_SOURCE_ORIGINS)[number];
export type SourceOriginI18nKey = `source_origin_${KnownSourceOrigin}`;

export function isKnownSourceOrigin(origin: string): origin is KnownSourceOrigin {
  return (KNOWN_SOURCE_ORIGINS as readonly string[]).includes(origin);
}

export function sourceOriginI18nKey(origin: KnownSourceOrigin): SourceOriginI18nKey {
  return `source_origin_${origin}`;
}

/** Task status → primitives/status-chip.css modifier. Single source of truth
 *  for the four pipeline statuses. Consumers compose with the base `.gp-status`. */
export const TASK_STATUS_CHIP: Record<Task['status'], string> = {
  pending: 'gp-status--pending',
  processing: 'gp-status--processing',
  done: 'gp-status--confirmed',
  error: 'gp-status--failed',
};

/** TaskLog.event values the UI knows how to render. The SDK types this as
 *  `string` (forward-compat for new pipeline events), so all consumers must
 *  narrow through `isLogEvent` before branching on it. */
export const LOG_EVENTS = ['start', 'end', 'error', 'skip'] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

export function isLogEvent(event: string): event is LogEvent {
  return (LOG_EVENTS as readonly string[]).includes(event);
}

/** i18n key per LogEvent — `task_detail.log.event_*`. Constraining at compile
 *  time keeps the consumer free of `t(\`event_${e}\` as string)` casts. */
export const EVENT_I18N_KEY = {
  start: 'event_start',
  end: 'event_end',
  error: 'event_error',
  skip: 'event_skip',
} as const satisfies Record<LogEvent, string>;

export function deriveTaskTitle(
  task: Pick<Task, 'inputType' | 'source'>,
  t: (key: string) => string,
): string {
  if (task.source?.title?.trim()) return task.source.title.trim();
  if (task.source?.originalUrl) {
    const url = task.source.originalUrl;
    return url.length > URL_DISPLAY_LIMIT ? `${url.slice(0, URL_DISPLAY_LIMIT)}…` : url;
  }
  switch (task.inputType) {
    case 'url':
      return t('title_url_submit');
    case 'text':
      return t('title_text_submit');
    case 'opinion':
      return t('title_opinion_submit');
    default:
      return t('title_unknown_submit');
  }
}
