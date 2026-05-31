'use client';
import type { DigestPeriod, DigestPreset, DigestSnapshotStatus } from '@goldpan/web-sdk';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { useTz } from '@/components/tz-provider';
import { shiftLocalDate, todayLocal } from '@/lib/format';

interface Props {
  channel: string;
  presets: DigestPreset[];
  presetId: number | null;
  /** Snapshot period; `null` (no snapshot for this date) → fall back to 'daily'. */
  period: DigestPeriod | null;
  /** YYYY-MM-DD UTC of the current snapshot, or the requested date when missing. */
  date: string;
  generatedAt: number | null;
  status: DigestSnapshotStatus | null;
  onChangePreset: (id: number | null) => void;
  onRegenerate: () => void;
  onShare: () => void;
  isPending: boolean;
}

// `date` 是已经按用户 tz 算出来的 YMD 字符串 (从 page / yesterdayLocal(tz) 来),
// 这里只是把它的字面值渲染出来给用户看 — 用 timeZone: 'UTC' 配合 Date.UTC 锚定
// 保证不再二次 tz 偏移 (否则西半球用户会看到日期早一天)。
function formatDayLabel(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(locale, {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatWeekday(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' });
}

function relativeAgo(generatedAt: number, rtf: Intl.RelativeTimeFormat): string {
  const diffMs = Date.now() - generatedAt;
  const days = Math.round(diffMs / 86400_000);
  if (Math.abs(days) >= 1) return rtf.format(-days, 'day');
  const hours = Math.round(diffMs / 3600_000);
  if (Math.abs(hours) >= 1) return rtf.format(-hours, 'hour');
  const mins = Math.round(diffMs / 60_000);
  return rtf.format(-mins, 'minute');
}

export function DigestToolbar({
  channel,
  presets,
  presetId,
  period,
  date,
  generatedAt,
  status,
  onChangePreset,
  onRegenerate,
  onShare,
  isPending,
}: Props) {
  const t = useTranslations('digest');
  const locale = useLocale();
  const tz = useTz();
  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === presetId) ?? null,
    [presets, presetId],
  );
  const presetLabel = selectedPreset?.name ?? t('toolbar_eyebrow_default_preset');
  // Cache the formatter on each render — `relativeAgo` previously instantiated
  // up to three formatters per render across its branches; one shared instance
  // reuses ICU machinery across day / hour / minute calls.
  const rtf = useMemo(() => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }), [locale]);
  const ago = generatedAt ? relativeAgo(generatedAt, rtf) : '';
  const periodLabel = period === 'weekly' ? t('toolbar_period_weekly') : t('toolbar_period_daily');
  const dayLabel = formatDayLabel(date, locale);
  const weekday = formatWeekday(date, locale);
  // windowMode 取自当前预设(snapshot 不存这字段);切预设后未 regenerate 时
  // subtitle 描述的是"按当前预设理解的窗口",与底层 snapshot 实际窗口可能短暂不一致。
  const effectivePeriod: DigestPeriod = period ?? 'daily';
  const windowMode = selectedPreset?.windowMode ?? 'calendar';
  const subtitle = t(`toolbar_subtitle_${effectivePeriod}_${windowMode}` as const);
  const dotClass =
    status === 'pending' || status === 'missing'
      ? 'gp-digest-toolbar__eyebrow-dot--warn'
      : 'gp-digest-toolbar__eyebrow-dot--ok';
  const prevDate = shiftLocalDate(date, -1);
  const nextDate = shiftLocalDate(date, 1);
  const nextDisabled = nextDate > todayLocal(tz);
  const presetQuery = (target: string): { date: string; presetId?: string; channel: string } => ({
    channel,
    date: target,
    ...(presetId != null ? { presetId: String(presetId) } : {}),
  });

  return (
    <header className="gp-digest-toolbar">
      <div className="gp-digest-toolbar__l">
        <p className="gp-digest-toolbar__eyebrow">
          <span className={`gp-digest-toolbar__eyebrow-dot ${dotClass}`} />
          <span>
            {t('toolbar_eyebrow_snapshot')} · {presetLabel}
            {ago ? ` · ${ago}` : ''}
          </span>
        </p>
        <h1 className="gp-digest-toolbar__h">
          {periodLabel} · {dayLabel}
        </h1>
        <p className="gp-digest-toolbar__sub">{subtitle}</p>
      </div>
      <div className="gp-digest-toolbar__r">
        <select
          aria-label={t('presetLabel')}
          className="gp-digest-toolbar__select"
          value={presetId ?? ''}
          onChange={(e) => onChangePreset(e.target.value ? Number(e.target.value) : null)}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="gp-datepick">
          <Link
            href={{ pathname: '/digest', query: presetQuery(prevDate) }}
            aria-label={t('toolbar_prev_day')}
            className="gp-datepick__btn"
          >
            ‹
          </Link>
          <div className="gp-datepick__core">
            <span className="gp-datepick__core-d">{date}</span>
            <span className="gp-datepick__core-w">{weekday}</span>
          </div>
          {nextDisabled ? (
            <button
              type="button"
              className="gp-datepick__btn"
              disabled
              aria-label={t('toolbar_next_day')}
            >
              ›
            </button>
          ) : (
            <Link
              href={{ pathname: '/digest', query: presetQuery(nextDate) }}
              aria-label={t('toolbar_next_day')}
              className="gp-datepick__btn"
            >
              ›
            </Link>
          )}
        </div>
        <button
          type="button"
          className="gp-btn"
          data-variant="icon"
          onClick={onRegenerate}
          disabled={isPending}
          aria-label={t('toolbar_regenerate')}
          title={t('toolbar_regenerate')}
        >
          ↻
        </button>
        <button
          type="button"
          className="gp-btn"
          data-variant="icon"
          onClick={onShare}
          aria-label={t('toolbar_share')}
          title={t('toolbar_share')}
        >
          ↗
        </button>
      </div>
    </header>
  );
}
