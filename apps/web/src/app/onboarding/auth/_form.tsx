// apps/web/src/app/onboarding/auth/_form.tsx
//
// Auth-form client component. The server page reads NODE_ENV and passes
// `isProduction` so this stays a pure client renderer.
//
// 历史与现状：本步骤已从 wizard 主流程隐藏（见 _components/steps.ts），IM 步骤
// 直接调用 `useWizardCommit` 完成提交。该路由文件保留是为了：
//   1. 用户直接访问 /onboarding/auth 仍可设置密码并提交（开发者偏好）；
//   2. 后续若需把权限保护重新加回向导，flip steps.ts 的 hidden 即可。
//
// Behaviour matrix:
//   - dev mode: toggle visible (default OFF). Off → no password collected,
//     submit is always available. On → password + confirm required, ≥8 chars.
//   - prod mode: toggle hidden (auth is always on). Password + confirm
//     required, ≥8 chars; submit blocked until valid.
//
// We sync wizard state via useEffect rather than on every keystroke through
// `patch` directly — that way we only PATCH the server when the value is
// actually valid (>=8 chars and matching). This avoids spamming the server
// with invalid intermediate states and matches the "wizard only stores
// canonical config" mental model. When the user toggles auth back off in dev,
// the effect clears `authPassword` server-side too.
'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Btn } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { PasswordInput } from '@/components/ui/password-input';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsHead } from '@/components/ui/settings-head';
import { Toggle } from '@/components/ui/toggle';
import { prevVisibleHref, visibleIndex, visibleTotal } from '../_components/steps';
import { formatErrorPath, useWizardCommit } from '../_components/use-wizard-commit';
import { WizardField } from '../_components/wizard-field';
import { useWizard, useWizardNavigate } from '../_components/wizard-state';

interface Props {
  isProduction: boolean;
}

export function AuthForm({ isProduction }: Props) {
  const t = useTranslations('onboarding.auth');
  const tt = useTranslations('onboarding');
  const tProgress = useTranslations('onboarding.progress');
  const nav = useWizardNavigate();
  const { state, patch } = useWizard();
  const { commit, committing, submitFailed, validationErrors } = useWizardCommit();

  // In production: auth always enabled; in dev: optional toggle (default OFF
  // unless a password is already in state from a previous wizard visit).
  const [authEnabled, setAuthEnabled] = useState(isProduction || Boolean(state.authPassword));
  const [pw, setPw] = useState(state.authPassword ?? '');
  const [pw2, setPw2] = useState(state.authPassword ?? '');
  const [pwVisible, setPwVisible] = useState(false);
  const [pw2Visible, setPw2Visible] = useState(false);

  // Keep wizard state in sync as user edits. We only PATCH when the value is
  // valid (avoids storing partially-typed passwords). Toggling off in dev
  // clears any previously stored password.
  useEffect(() => {
    if (!authEnabled) {
      if (state.authPassword) patch({ authPassword: null });
      return;
    }
    if (pw && pw === pw2 && pw.length >= 8) {
      if (state.authPassword !== pw) patch({ authPassword: pw });
    }
  }, [authEnabled, pw, pw2, state.authPassword, patch]);

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const valid = !authEnabled || (pw.length >= 8 && pw === pw2);
  const canCommit = (isProduction ? authEnabled && valid : valid) && !committing;

  return (
    <>
      <SettingsHead
        crumb={tProgress('step_n_of_total', {
          current: visibleIndex('auth'),
          total: visibleTotal(),
        })}
        heading={t('section_title')}
        desc={isProduction ? t('prod_intro') : t('dev_intro')}
      />

      {!isProduction && (
        <SettingsCard
          heading={t('enable_label')}
          sub={t('enable_sub')}
          right={<Toggle on={authEnabled} onChange={setAuthEnabled} />}
        />
      )}

      {authEnabled && (
        <SettingsCard heading={t('credentials_section')}>
          <WizardField
            label={t('password_label')}
            hint={
              tooShort ? (
                <span className="gp-onboarding-danger-text">{t('password_too_short')}</span>
              ) : null
            }
            control={
              <PasswordInput
                value={pw}
                onChange={setPw}
                visible={pwVisible}
                onToggleVisible={() => setPwVisible((v) => !v)}
                invalid={tooShort}
                showAriaLabel={t('password_show_aria')}
                hideAriaLabel={t('password_hide_aria')}
              />
            }
          />
          <WizardField
            label={t('password_confirm_label')}
            hint={
              mismatch ? (
                <span className="gp-onboarding-danger-text">{t('password_mismatch')}</span>
              ) : null
            }
            control={
              <PasswordInput
                value={pw2}
                onChange={setPw2}
                visible={pw2Visible}
                onToggleVisible={() => setPw2Visible((v) => !v)}
                invalid={mismatch}
                showAriaLabel={t('password_show_aria')}
                hideAriaLabel={t('password_hide_aria')}
              />
            }
          />
        </SettingsCard>
      )}

      {validationErrors && (
        <Notice kind="warn" heading={t('validation_failed_title')}>
          <p>{t('validation_failed_body')}</p>
          <ul className="gp-onboarding-errors">
            {validationErrors.map((e) => (
              // path + message together is a stable identity for a Zod issue.
              <li key={`${formatErrorPath(e.path) || 'err'}::${e.message ?? ''}`}>
                <code>{formatErrorPath(e.path)}</code>: {e.message ?? ''}
              </li>
            ))}
          </ul>
          <p className="gp-onboarding-errors-back">{t('validation_back_to_edit')}</p>
        </Notice>
      )}
      {submitFailed && (
        <Notice kind="warn" heading={t('submit_failed_title')}>
          {t('submit_failed_body')}
        </Notice>
      )}

      <div className="gp-onboarding__actions gp-onboarding__actions--split">
        <Btn kind="ghost" onClick={() => nav(prevVisibleHref('auth'))}>
          {tt('back_button')}
        </Btn>
        <Btn kind="primary" disabled={!canCommit} onClick={commit}>
          {committing ? t('submitting') : t('submit_button')}
        </Btn>
      </div>
    </>
  );
}
