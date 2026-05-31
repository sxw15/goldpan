'use client';

import { isValidIanaTz } from '@goldpan/core/lib/tz';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { Btn } from '@/components/ui/button';
import { SettingsCard } from '@/components/ui/settings-card';
import { useWizard } from './wizard-state';

/**
 * UTC offset 选项: UTC-12 → UTC+14。Etc/GMT 命名 POSIX 反转 (Etc/GMT-N
 * 表示 UTC+N),所以这里 etcSign 跟用户看的 sign 相反。
 */
const OFFSET_OPTIONS: { label: string; value: string }[] = [];
for (let n = -12; n <= 14; n++) {
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n);
  const etcSign = n >= 0 ? '-' : '+';
  const value = n === 0 ? 'Etc/GMT' : `Etc/GMT${etcSign}${abs}`;
  OFFSET_OPTIONS.push({ label: `UTC${sign}${abs}`, value });
}

function formatNowInTz(tz: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  let y = '';
  let mo = '';
  let d = '';
  let h = '';
  let m = '';
  let s = '';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    if (p.type === 'month') mo = p.value;
    if (p.type === 'day') d = p.value;
    if (p.type === 'hour') h = p.value;
    if (p.type === 'minute') m = p.value;
    if (p.type === 'second') s = p.value;
  }
  if (h === '24') h = '00';
  return `${y}-${mo}-${d} ${h}:${m}:${s}`;
}

/**
 * 浏览器探测当前 tz,IANA 校验通过才返回。给 TzCard 内部用,也供 page.tsx
 * next() auto-default 复用 — 让用户即使没点「时间正确」直接「下一步」,
 * 也能把检测到的 tz 写进 state(否则 commit 会漏写 GOLDPAN_TIMEZONE,
 * server 退回到 host tz,Docker 容器场景下跟用户浏览器 tz 可能不一致)。
 */
export function detectBrowserTz(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isValidIanaTz(tz)) return tz;
    return null;
  } catch {
    return null;
  }
}

export function TzCard(): React.JSX.Element {
  const t = useTranslations('onboarding');
  const { state, patch } = useWizard();

  const detected = useMemo(() => detectBrowserTz(), []);
  const [mode, setMode] = useState<'detected' | 'offset'>(detected ? 'detected' : 'offset');
  const [selectedOffset, setSelectedOffset] = useState<string>('Etc/GMT');
  // `new Date()` differs between SSR and client hydrate (~1s apart) — defer
  // the live time until after mount, then re-render every second.
  const [mounted, setMounted] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    setMounted(true);
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Summary state — wizard already committed a tz this session. Skip the
  // "Detected:" label (would lie for the offset path) — say "已设置" instead.
  if (state.timezone) {
    return (
      <SettingsCard
        heading={t('tz_card_heading')}
        sub={t('tz_card_summary', { tz: state.timezone })}
      />
    );
  }

  if (mode === 'detected' && detected) {
    const sub = t('tz_card_sub_detected', {
      tz: detected,
      time: mounted ? formatNowInTz(detected) : '—',
    });
    return (
      <SettingsCard
        heading={t('tz_card_heading')}
        sub={sub}
        right={
          <div className="gp-tz-card__actions">
            <Btn kind="primary" sm onClick={() => patch({ timezone: detected })}>
              {t('tz_card_correct_button')}
            </Btn>
            <Btn kind="ghost" sm onClick={() => setMode('offset')}>
              {t('tz_card_wrong_button')}
            </Btn>
          </div>
        }
      />
    );
  }

  // Offset mode (probe failed → land here directly; or user clicked "不对").
  const selectedLabel = OFFSET_OPTIONS.find((o) => o.value === selectedOffset)?.label ?? 'UTC';
  const previewTime = mounted ? formatNowInTz(selectedOffset) : '—';
  const sub = !detected
    ? t('tz_card_sub_probe_failed', { offset: selectedLabel, time: previewTime })
    : t('tz_card_sub_offset', { offset: selectedLabel, time: previewTime });
  return (
    <SettingsCard
      heading={t('tz_card_heading')}
      sub={sub}
      right={
        <div className="gp-tz-card__actions">
          <select
            id="tz-offset"
            className="gp-sselect"
            aria-label={t('tz_card_pick_offset')}
            value={selectedOffset}
            onChange={(e) => setSelectedOffset(e.target.value)}
          >
            {OFFSET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <Btn kind="primary" sm onClick={() => patch({ timezone: selectedOffset })}>
            {t('tz_card_apply_button')}
          </Btn>
        </div>
      }
    />
  );
}
