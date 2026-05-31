'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { probeDigestStatus } from '@/app/digest/actions';

type StatusState = 'idle' | 'checking' | 'fail' | 'ok';

const SETTINGS_HREF = '/settings?group=digest';

function MockPreview() {
  const t = useTranslations('digest');
  const items = [
    {
      title: t('disabled_mock_preview_item_1'),
      bullet: true,
    },
    {
      title: t('disabled_mock_preview_item_2'),
      bullet: true,
    },
  ];
  const chips = [
    t('disabled_mock_preview_chip_1'),
    t('disabled_mock_preview_chip_2'),
    t('disabled_mock_preview_chip_3'),
    t('disabled_mock_preview_chip_4'),
    t('disabled_mock_preview_chip_5'),
    t('disabled_mock_preview_chip_6'),
  ];
  return (
    <div className="gp-digest-mockpreview" aria-hidden="true">
      <div className="gp-digest-mockpreview__caption">{t('disabled_preview_caption')}</div>
      <div className="gp-digest-mockpreview__inner">
        <div className="gp-digest-mockpreview__title-row">
          <span className="gp-digest-mockpreview__h">{t('disabled_preview_today')}</span>
          <span className="gp-digest-mockpreview__date">{t('disabled_preview_ago')}</span>
        </div>
        <div className="gp-digest-mockpreview__statgrid">
          <div className="gp-digest-mockpreview__stat">
            <div className="gp-digest-mockpreview__stat-l">{t('stats_label_captures')}</div>
            <div className="gp-digest-mockpreview__stat-v">2</div>
          </div>
          <div className="gp-digest-mockpreview__stat">
            <div className="gp-digest-mockpreview__stat-l">{t('stats_label_thoughts')}</div>
            <div className="gp-digest-mockpreview__stat-v">1</div>
          </div>
          <div className="gp-digest-mockpreview__stat">
            <div className="gp-digest-mockpreview__stat-l">{t('stats_label_entities')}</div>
            <div className="gp-digest-mockpreview__stat-v">14</div>
          </div>
          <div className="gp-digest-mockpreview__stat">
            <div className="gp-digest-mockpreview__stat-l">{t('stats_label_findings')}</div>
            <div className="gp-digest-mockpreview__stat-v" style={{ color: 'var(--gp-ink-faint)' }}>
              0
            </div>
          </div>
        </div>
        {items.map((it) => (
          <div className="gp-digest-mockpreview__row" key={it.title}>
            <div className="gp-digest-mockpreview__row-bullet" />
            <div className="gp-digest-mockpreview__row-text">{it.title}</div>
          </div>
        ))}
        <div className="gp-digest-mockpreview__chiprow">
          {chips.map((c) => (
            <span className="gp-digest-mockpreview__chip" key={c}>
              {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function EnableCard() {
  const t = useTranslations('digest');
  return (
    <div className="gp-digest-enable">
      <h2 className="gp-digest-enable__h">{t('disabled_enable_title')}</h2>
      <p className="gp-digest-enable__desc">{t('disabled_enable_desc')}</p>
      <Link href={SETTINGS_HREF} className="gp-digest-enable__cta">
        {t('disabled_enable_cta')}
      </Link>
      <p className="gp-digest-enable__path">{t('disabled_enable_path')}</p>
    </div>
  );
}

function StatusCheck({ channel }: { channel: string }) {
  const t = useTranslations('digest');
  const router = useRouter();
  const [state, setState] = useState<StatusState>('idle');
  const [isPending, start] = useTransition();
  const labels = {
    idle: { t: t('disabled_status_idle_t'), s: t('disabled_status_idle_s'), icon: '↻' },
    checking: { t: t('disabled_status_checking_t'), s: t('disabled_status_checking_s'), icon: '↻' },
    fail: { t: t('disabled_status_fail_t'), s: t('disabled_status_fail_s'), icon: '✕' },
    ok: { t: t('disabled_status_ok_t'), s: t('disabled_status_ok_s'), icon: '✓' },
  };
  const cur = labels[state];
  const click = () => {
    setState('checking');
    start(async () => {
      const res = await probeDigestStatus(channel);
      if (res.ok && res.enabled) {
        setState('ok');
        // Server will now return preview data instead of plugin_disabled —
        // refresh the route so the page swaps from disabled view to enabled view.
        router.refresh();
      } else {
        setState('fail');
      }
    });
  };
  const buttonLabel =
    state === 'checking'
      ? t('disabled_status_button_checking')
      : state === 'ok'
        ? t('disabled_status_button_loading')
        : t('disabled_status_button_idle');
  const iconState = state === 'checking' ? 'checking' : state === 'ok' ? 'ok' : 'fail';
  return (
    <div className="gp-digest-statuscheck">
      <div className="gp-digest-statuscheck__l">
        <span className="gp-digest-statuscheck__icon" data-state={iconState}>
          {cur.icon}
        </span>
        <div>
          <div className="gp-digest-statuscheck__t">{cur.t}</div>
          <div className="gp-digest-statuscheck__sub">{cur.s}</div>
        </div>
      </div>
      <button
        type="button"
        className="gp-digest-statuscheck__btn"
        onClick={click}
        disabled={isPending || state === 'checking' || state === 'ok'}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

export function DisabledView({ channel }: { channel: string }) {
  const t = useTranslations('digest');
  const bullets = [
    { n: '01', h: t('disabled_value_1_h'), d: t('disabled_value_1_d') },
    { n: '02', h: t('disabled_value_2_h'), d: t('disabled_value_2_d') },
    { n: '03', h: t('disabled_value_3_h'), d: t('disabled_value_3_d') },
  ];
  return (
    <div className="gp-digest-disabled">
      <div className="gp-digest-disabled__eyebrow">
        <span className="gp-digest-disabled__eyebrow-dot" />
        <span>
          {t('disabled_eyebrow')} · {t('disabled_plugin_id')}
        </span>
      </div>
      <h1 className="gp-digest-disabled__title">{t('disabled_title')}</h1>
      <p className="gp-digest-disabled__lede">
        {t('disabled_lede_before')}
        <code>{t('disabled_plugin_id')}</code>
        {t('disabled_lede_after')}
      </p>

      <ul className="gp-digest-disabled__value">
        {bullets.map((b) => (
          <li key={b.n}>
            <span className="gp-digest-disabled__value-num">{b.n}</span>
            <span className="gp-digest-disabled__value-h">{b.h}</span>
            <span className="gp-digest-disabled__value-d">{b.d}</span>
          </li>
        ))}
      </ul>

      <MockPreview />

      <EnableCard />

      <StatusCheck channel={channel} />
    </div>
  );
}
