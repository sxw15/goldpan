// apps/web/src/app/onboarding/page.tsx
//
// F1 — wizard step 1: language selection + UI theme + built-in web UI toggle.
//
// Mounted at /onboarding (basic step). The page is a client component because
// it reads / writes the wizard state via useWizard() and triggers a
// router.refresh() after locale change so next-intl re-runs getRequestConfig
// against the freshly set wizard-locale cookie.
'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useTheme } from '@/components/theme-provider';
import { Btn } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsHead } from '@/components/ui/settings-head';
import { Toggle } from '@/components/ui/toggle';
import {
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  isSupportedLocale,
  type SupportedLocale,
} from '@/i18n/locales';
import type { Theme } from '@/lib/theme-cycle';
import { setWizardLocale } from './_actions';
import { nextVisibleHref, visibleIndex, visibleTotal } from './_components/steps';
import { detectBrowserTz, TzCard } from './_components/tz-card';
import { useWizard, useWizardNavigate } from './_components/wizard-state';

/** Locale-picker layout switches from Segmented to native <select> once the
 *  list grows past this many entries. Segmented stays readable for ≤3 items;
 *  beyond that, the row would wrap or get squeezed, and a dropdown is the
 *  honest UI affordance. */
const SEGMENTED_LOCALE_THRESHOLD = 3;

export default function OnboardingHome() {
  const t = useTranslations('onboarding');
  const tProgress = useTranslations('onboarding.progress');
  // Theme labels live in settings.appearance — reuse to avoid duplication.
  const tAppearance = useTranslations('settings.appearance');
  const locale = useLocale();
  const router = useRouter();
  const nav = useWizardNavigate();
  const { state, patch } = useWizard();
  const { theme, setTheme } = useTheme();
  const [showWarning, setShowWarning] = useState(false);

  // Server reports `_languageLocked: true` when metadata.language is already
  // set (re-entry case from /settings/onboarding). For first-time wizard the
  // lock is false. The flag is set on the wizard state by H1 (re-entry path)
  // — for V1 first-time wizard this stays falsy.
  const languageLocked = Boolean((state as { _languageLocked?: boolean })._languageLocked);

  // Effective language = state.language 优先；否则按当前 next-intl locale 兜底；
  // 再 fallback 到 DEFAULT_LOCALE。Segmented 高亮和 Next 按钮都跟这个值走 ——
  // 否则用户首次进 onboarding 时 state.language 还没 patch，按钮会被
  // `!state.language` gate 卡住，从顶部 stepper 点回第 1 步也复现同一 bug。
  // Next 时再把这个 effective 值显式 patch 进 state，server 拿到完整 language。
  const effectiveLanguage: SupportedLocale = isSupportedLocale(state.language)
    ? state.language
    : isSupportedLocale(locale)
      ? locale
      : DEFAULT_LOCALE;

  async function chooseLanguage(lang: SupportedLocale): Promise<void> {
    if (languageLocked) return;
    await setWizardLocale(lang);
    await patch({ language: lang });
    router.refresh();
  }

  // 用户没点「时间正确」就直接「下一步」时,在这里 auto-default 到检测到
  // 的 tz — 跟 language 的 effectiveLanguage 同样的 pattern,避免漏写
  // GOLDPAN_TIMEZONE 让 server 退回到可能不同的 host tz。
  // 边界: 用户点了「时间不对」但没 Apply 就「下一步」 → 也会 auto-default
  // 到 detected。算 forgiving:dissent 没真正落地,沿用 detected 是合理回退。
  const detectedTz = useMemo(() => detectBrowserTz(), []);

  async function next(): Promise<void> {
    if (!state.language) {
      await patch({ language: effectiveLanguage });
    }
    if (!state.timezone && detectedTz) {
      await patch({ timezone: detectedTz });
    }
    nav(nextVisibleHref('basic'));
  }

  function toggleWeb(checked: boolean): void {
    if (checked) {
      patch({ webEnabled: true });
      setShowWarning(false);
    } else {
      // Don't immediately set false — surface confirmation first. The toggle
      // visually reverts because we control `on` from state, which we haven't
      // patched yet.
      setShowWarning(true);
    }
  }

  function confirmDisableWeb(): void {
    patch({ webEnabled: false });
    setShowWarning(false);
  }

  function cancelDisableWeb(): void {
    setShowWarning(false);
  }

  return (
    <>
      <SettingsHead
        crumb={tProgress('step_n_of_total', {
          current: visibleIndex('basic'),
          total: visibleTotal(),
        })}
        heading={t('welcome_title')}
        desc={t('welcome_desc', { total: visibleTotal() })}
      />

      <SettingsCard
        heading={t('language_section_title')}
        sub={languageLocked ? t('language_locked_tooltip') : t('language_section_desc')}
        right={
          AVAILABLE_LOCALES.length <= SEGMENTED_LOCALE_THRESHOLD ? (
            <Segmented<SupportedLocale>
              value={effectiveLanguage}
              options={AVAILABLE_LOCALES.map((loc) => ({ value: loc.code, label: loc.label }))}
              onChange={(v) => {
                void chooseLanguage(v);
              }}
            />
          ) : (
            <select
              className="gp-sselect"
              aria-label={t('language_select_aria')}
              value={effectiveLanguage}
              disabled={languageLocked}
              onChange={(ev) => {
                if (isSupportedLocale(ev.target.value)) {
                  void chooseLanguage(ev.target.value);
                }
              }}
            >
              {AVAILABLE_LOCALES.map((loc) => (
                <option key={loc.code} value={loc.code}>
                  {loc.label}
                </option>
              ))}
            </select>
          )
        }
      />

      <TzCard />

      <SettingsCard
        heading={t('theme_section_title')}
        sub={t('theme_section_desc')}
        right={
          <Segmented<Theme>
            value={theme}
            options={[
              { value: 'system', label: tAppearance('theme_system') },
              { value: 'light', label: tAppearance('theme_light') },
              { value: 'dark', label: tAppearance('theme_dark') },
            ]}
            onChange={(v) => setTheme(v)}
          />
        }
      />

      {/* UI hidden: product decision — keep mount + wizard state; re-show via CSS. */}
      <div className="gp-onboarding__web-toggle-card" aria-hidden="true">
        <SettingsCard
          heading={t('web_toggle_title')}
          sub={t('web_toggle_description')}
          right={<Toggle on={state.webEnabled !== false} onChange={(on) => toggleWeb(on)} />}
        />
      </div>

      {showWarning && (
        <Notice
          kind="warn"
          heading={t('web_toggle_off_warning_title')}
          trailing={
            <div className="gp-onboarding-banner-actions">
              <Btn kind="ghost" sm onClick={cancelDisableWeb}>
                {t('web_toggle_off_cancel')}
              </Btn>
              <Btn kind="danger" sm onClick={confirmDisableWeb}>
                {t('web_toggle_off_confirm')}
              </Btn>
            </div>
          }
        >
          {t('web_toggle_off_warning_body')}
        </Notice>
      )}

      <div className="gp-onboarding__actions gp-onboarding__actions--end">
        <Btn
          kind="primary"
          onClick={() => {
            void next();
          }}
        >
          {t('next_button')}
        </Btn>
      </div>
    </>
  );
}
