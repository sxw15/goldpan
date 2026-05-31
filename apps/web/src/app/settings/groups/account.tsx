'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Btn } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PasswordInput } from '@/components/ui/password-input';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsField } from '@/components/ui/settings-field';
import { SettingsHead } from '@/components/ui/settings-head';
import { Toggle } from '@/components/ui/toggle';
import { useEditableCommit, useToggleCommit } from '@/components/ui/use-field-commit';
import type { GroupProps } from '../settings-shell';
import { useFieldTagLabels } from '../use-field-tag-labels';

// Password reset is a destructive + restart-coupled action: clear the
// override (login goes from `configured` → `unconfigured` = anyone can
// reach the instance) AND restart the server so the new state takes
// effect. The shell-level RestartPrompt fires automatically after any
// commit with restart-required keys — for password reset we suppress
// that path and run our own confirm dialog instead, because:
//   - the user needs an UP-FRONT explanation of "this clears the
//     password and any user can access the instance after restart",
//     not an after-the-fact "you should restart now"
//   - merging confirm + restart into one modal halves the number of
//     clicks (and modals) the user has to acknowledge
// The `resetEnvKeyAndRestart` GroupProps helper drives the bypass + the
// restart so this component only owns the local progress UI.
type PwdResetPhase = 'idle' | 'confirming' | 'resetting' | 'restarting' | 'error';

export function GroupAccount({
  env,
  resetEnvKey,
  resetEnvKeyAndRestart,
  commit,
  setFieldEditing,
}: GroupProps) {
  const tA11y = useTranslations('settings.a11y');
  const t = useTranslations('settings.account');
  const tActions = useTranslations('settings.actions');
  const fieldTagLabels = useFieldTagLabels();
  const [editPwd, setEditPwd] = useState(false);
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [pwdVisible, setPwdVisible] = useState(false);
  const [pwd2Visible, setPwd2Visible] = useState(false);
  const [resettingSsrf, setResettingSsrf] = useState(false);
  const [pwdResetPhase, setPwdResetPhase] = useState<PwdResetPhase>('idle');
  const [pwdResetError, setPwdResetError] = useState<string | null>(null);

  const ssrfState = env.get('GOLDPAN_SSRF_VALIDATION_ENABLED');
  const ssrfCommit = useToggleCommit({
    envKey: 'GOLDPAN_SSRF_VALIDATION_ENABLED',
    committed: ssrfState?.mask ?? 'false',
    commit,
    fieldName: t('field_ssrf_label'),
    baselineDiffers: ssrfState?.baselineDiffers,
  });
  // ssrfEnabled is the OPTIMISTIC value from useToggleCommit (rolls back to
  // ssrfState?.mask on commit failure). Auto-commit doesn't write to dirty
  // store, so no fallback chain needed.
  const ssrfEnabled = ssrfCommit.current === 'true';

  const pwdState = env.get('GOLDPAN_AUTH_PASSWORD');
  // Password commit driven by useEditableCommit. The hook holds state machine,
  // but account.tsx STILL owns the secondary confirm-password input + visibility
  // toggles + length/mismatch validation (those are password-specific UX, not
  // the commit primitive). When the user clicks [保存], we forward the
  // confirmed password to `pwdCommit.save(pwd)` via the overrideValue path,
  // which avoids the setDraft + save stale-closure footgun.
  //
  // `committed` is intentionally empty string — env-state masks the existing
  // password value. The hook's `dirty` flag is unused here (we drive submit
  // from `canConfirm` validation locally).
  const pwdCommit = useEditableCommit({
    envKey: 'GOLDPAN_AUTH_PASSWORD',
    committed: '',
    commit,
    fieldName: t('field_password_label'),
    baselineDiffers: pwdState?.baselineDiffers,
  });
  const pwdConfigured = pwdState?.configured === true;

  // Mark the password row as "editing" whenever the user has the form open
  // AND has typed something. Drives the shell's leave-guard so a failed
  // save that leaves editPwd=true (form open) won't let group switching /
  // tab close drop the retry draft without warning. Cleared on success
  // (exitEdit sets editPwd=false) and on unmount (cleanup below).
  useEffect(() => {
    const hasDraft = editPwd && (pwd.length > 0 || pwd2.length > 0);
    setFieldEditing('GOLDPAN_AUTH_PASSWORD', hasDraft);
    return () => setFieldEditing('GOLDPAN_AUTH_PASSWORD', false);
  }, [editPwd, pwd, pwd2, setFieldEditing]);

  // Trim-equivalent check rejects 8 spaces, leading/trailing whitespace, and
  // other non-printable padding that would pass the bare length>=8 rule but
  // produce an unusable password. .env files don't preserve quoted whitespace
  // reliably across the dotenv parser anyway.
  const tooShort = editPwd && pwd.length > 0 && (pwd.length < 8 || pwd.trim().length < 8);
  const mismatch = editPwd && pwd2.length > 0 && pwd !== pwd2;
  const canConfirm = editPwd && pwd.length >= 8 && pwd.trim().length >= 8 && pwd === pwd2;

  // preserveStatus distinguishes the two callers:
  //  - cancel button (preserveStatus=false): user is abandoning the edit.
  //    Call pwdCommit.cancel() to wipe any leftover 'error' state from a
  //    previous failed attempt so the row doesn't keep showing a red row
  //    for a draft the user already discarded.
  //  - save success (preserveStatus=true): the hook just set state to
  //    'saved' / 'pending-restart'. Calling cancel() here would re-run the
  //    `if (state === 'error') setState('pristine')` branch — but the
  //    closure captured at click time (when state was 'error' after a
  //    failed retry) still sees state='error' and wipes the just-set
  //    success status. Skip cancel on the success path; the form-local
  //    inputs still need clearing.
  const exitEdit = (preserveStatus = false) => {
    setEditPwd(false);
    setPwd('');
    setPwd2('');
    setPwdVisible(false);
    setPwd2Visible(false);
    if (!preserveStatus) {
      pwdCommit.cancel();
    }
  };

  // Drive the password reset + restart flow from the confirm dialog. The
  // helper itself talks to the server (commitEnv null + serverRestart +
  // poll); we just translate its tagged result back into local phase /
  // error state. On `success` the page is about to reload so any state
  // we set here is moot, but we still leave the modal in 'restarting' so
  // the user sees consistent progress text up to the reload moment.
  const handleConfirmPwdReset = async () => {
    setPwdResetPhase('resetting');
    setPwdResetError(null);
    const result = await resetEnvKeyAndRestart('GOLDPAN_AUTH_PASSWORD', () => {
      // Both 'restart-requested' and 'restart-polling' surface as the
      // same user-facing "restarting" phase — the distinction (POST vs
      // /health polling) is finer-grained than the user cares about
      // and would just churn the modal copy.
      setPwdResetPhase('restarting');
    });
    if (result.kind === 'success') return;
    if (result.kind === 'reset-failed') {
      // The shell already toasted the reset failure; reflect it in the
      // FieldStatus row too, mirroring the legacy resetEnvKey path so
      // the row doesn't keep claiming "Saved · restart" for an
      // unsaved-because-rejected override.
      pwdCommit.markError(tActions('reset_failed_inline'));
      setPwdResetError(
        result.reason === 'network'
          ? t('reset_error_network')
          : result.message
            ? t('reset_error_with_detail', { message: result.message })
            : t('reset_error_unknown'),
      );
    } else {
      // Reset DID persist on the server (password override is gone) —
      // only the restart half failed. Tell pwdCommit to clear so the
      // FieldStatus stops showing the old "Saved · restart" indicator
      // for a password that's already gone. The dialog then shows the
      // restart-side error so the user can manually retry / refresh.
      pwdCommit.clear();
      setPwdResetError(
        result.reason === 'timeout'
          ? t('restart_error_timeout')
          : result.message
            ? t('restart_error_with_detail', { message: result.message })
            : t('restart_error_unknown'),
      );
    }
    setPwdResetPhase('error');
  };

  // Centralized close handler — the modal renders three different
  // interactive phases ('confirming' / 'error' both closable, plus a
  // closable 'idle' transition); 'resetting' / 'restarting' are
  // intentionally non-closable so the user can't dismiss mid-network
  // and end up with a half-applied reset and no UI to recover from.
  const closePwdResetModal = () => {
    if (pwdResetPhase === 'resetting' || pwdResetPhase === 'restarting') return;
    setPwdResetPhase('idle');
    setPwdResetError(null);
  };

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />
      <SettingsCard heading={t('card_login')}>
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_password_label')}
          hint={t('field_password_hint')}
          env="GOLDPAN_AUTH_PASSWORD"
          restart="restart"
          stack={editPwd}
          source={pwdState?.source}
          baselineDiffers={pwdState?.baselineDiffers}
          onReset={
            pwdState?.source === 'override' &&
            !editPwd &&
            pwdCommit.state !== 'saving' &&
            pwdResetPhase === 'idle'
              ? () => {
                  // Open the confirm + restart dialog. The actual reset
                  // (and the subsequent server restart) fire inside
                  // handleConfirmPwdReset; the dialog explains both
                  // up front so the user can back out before destroying
                  // the password.
                  setPwdResetError(null);
                  setPwdResetPhase('confirming');
                }
              : undefined
          }
          resetting={pwdResetPhase === 'resetting' || pwdResetPhase === 'restarting'}
          resetLabel={tActions('reset')}
          resetInProgressLabel={tActions('reset_in_progress')}
          resetTitle={tActions('reset_hint')}
          shadowed={pwdState?.source === 'override' && pwdState?.baselineDiffers === true}
          status={pwdCommit.status}
          value={
            editPwd ? (
              <div className="gp-account-pwd-edit">
                <PasswordInput
                  autoFocus
                  value={pwd}
                  onChange={setPwd}
                  visible={pwdVisible}
                  onToggleVisible={() => setPwdVisible((v) => !v)}
                  invalid={tooShort}
                  // Lock both inputs while pwdCommit is saving. The save
                  // path captures `pwd` at click time, so further typing
                  // would be silently dropped once exitEdit clears the
                  // form on success — confusing the user about what was
                  // actually committed.
                  disabled={pwdCommit.state === 'saving'}
                  showAriaLabel={t('password_show_aria')}
                  hideAriaLabel={t('password_hide_aria')}
                  placeholder={tA11y('password_placeholder')}
                  className="gp-sinput"
                />
                {tooShort ? (
                  <span className="gp-account-pwd-edit__error">{t('password_too_short')}</span>
                ) : null}
                <label className="gp-account-pwd-edit__sublabel" htmlFor="gp-account-pwd-confirm">
                  {t('password_confirm_label')}
                </label>
                <PasswordInput
                  id="gp-account-pwd-confirm"
                  value={pwd2}
                  onChange={setPwd2}
                  visible={pwd2Visible}
                  onToggleVisible={() => setPwd2Visible((v) => !v)}
                  invalid={mismatch}
                  disabled={pwdCommit.state === 'saving'}
                  showAriaLabel={t('password_show_aria')}
                  hideAriaLabel={t('password_hide_aria')}
                  className="gp-sinput"
                />
                {mismatch ? (
                  <span className="gp-account-pwd-edit__error">{t('password_mismatch')}</span>
                ) : null}
              </div>
            ) : pwdConfigured ? (
              t('password_configured')
            ) : (
              t('value_unconfigured')
            )
          }
          control={
            editPwd ? (
              <>
                <Btn sm onClick={() => exitEdit()} disabled={pwdCommit.state === 'saving'}>
                  {t('cancel_button')}
                </Btn>
                <Btn
                  sm
                  kind="primary"
                  disabled={!canConfirm || pwdCommit.state === 'saving'}
                  onClick={async () => {
                    // Bridge: pwd is held locally (for confirm-password UX); pass it
                    // directly to save() via overrideValue. This avoids the setState +
                    // stale-closure race that would happen if we did setDraft(pwd)
                    // before save() — save's closure captures `draft`, not the just-
                    // enqueued new state.
                    const outcome = await pwdCommit.save(pwd);
                    // Exhaustive branching on CommitOutcome's discriminant —
                    // every variant gets an explicit decision instead of the
                    // earlier `outcome && outcome.kind !== 'error'` truthy
                    // short-circuit, which silently bundled superseded /
                    // no-op into the "exit edit" branch.
                    switch (outcome.kind) {
                      case 'saved':
                      case 'pending-restart':
                        // preserveStatus=true: hook just set 'saved' /
                        // 'pending-restart'; exitEdit must NOT call
                        // pwdCommit.cancel() — the captured closure
                        // (state='error' from the failed attempt this
                        // retry replaced) would set 'pristine' and erase
                        // the just-set success indicator.
                        exitEdit(true);
                        break;
                      case 'error':
                        // FieldStatus renders the inline error message; keep
                        // the edit form open so the user can fix and retry.
                        break;
                      case 'no-op':
                        // overrideValue is always passed above, so save()
                        // can't actually reach the no-op short-circuit (it
                        // requires `overrideValue === undefined`). Branch
                        // exists for type completeness; exit cleanly if it
                        // ever fires to avoid a stuck edit form. Same
                        // preserveStatus rationale as 'saved' above —
                        // no-op means the hook's state is unchanged, and
                        // calling cancel() would still risk wiping it.
                        exitEdit(true);
                        break;
                      case 'superseded':
                        // Another fire/save bumped us — typically because
                        // the user clicked Save twice or navigated mid-
                        // submit. Leave the form open so the in-flight
                        // attempt's resolution gets the final say.
                        break;
                    }
                  }}
                >
                  {pwdCommit.state === 'saving' ? t('saving_button') : t('save_button')}
                </Btn>
              </>
            ) : (
              <Btn sm onClick={() => setEditPwd(true)}>
                {pwdConfigured ? t('refill_button') : t('fill_button')}
              </Btn>
            )
          }
        />
      </SettingsCard>

      <SettingsCard heading={t('card_ssrf_heading')} sub={t('card_ssrf_sub')}>
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_ssrf_label')}
          hint={t('field_ssrf_hint')}
          env="GOLDPAN_SSRF_VALIDATION_ENABLED"
          restart="restart"
          source={ssrfState?.source}
          baselineDiffers={ssrfState?.baselineDiffers}
          shadowed={ssrfState?.source === 'override' && ssrfState?.baselineDiffers === true}
          onReset={
            ssrfState?.source === 'override' && ssrfCommit.state !== 'saving'
              ? async () => {
                  setResettingSsrf(true);
                  try {
                    const ok = await resetEnvKey('GOLDPAN_SSRF_VALIDATION_ENABLED');
                    if (ok) {
                      ssrfCommit.clear();
                    } else {
                      // See password handler above for the markError
                      // rationale — toast fades, FieldStatus must not lie.
                      ssrfCommit.markError(tActions('reset_failed_inline'));
                    }
                  } finally {
                    setResettingSsrf(false);
                  }
                }
              : undefined
          }
          resetting={resettingSsrf}
          resetLabel={tActions('reset')}
          resetInProgressLabel={tActions('reset_in_progress')}
          resetTitle={tActions('reset_hint')}
          status={ssrfCommit.status}
          value={ssrfEnabled ? t('ssrf_on_label') : t('ssrf_off_label')}
          control={
            <Toggle
              on={ssrfEnabled}
              ariaLabel={t('field_ssrf_label')}
              disabled={ssrfCommit.state === 'saving'}
              onChange={(v) => {
                void ssrfCommit.fire(v ? 'true' : 'false');
              }}
            />
          }
        />
        {ssrfEnabled ? (
          <Notice
            kind="info"
            icon="ⓘ"
            heading={t('ssrf_on_info_heading')}
            className="gp-notice--card-footer"
          >
            {t('ssrf_on_info_body')}
            <details className="gp-ssrf-help">
              <summary>{t('ssrf_on_info_why')}</summary>
              <p>{t('ssrf_on_info_why_body')}</p>
            </details>
          </Notice>
        ) : (
          <Notice
            kind="warn"
            icon="⚠"
            heading={t('ssrf_off_warn_heading')}
            className="gp-notice--card-footer"
          >
            {t('ssrf_off_warn_body')}
          </Notice>
        )}
      </SettingsCard>

      {pwdResetPhase !== 'idle' && pwdResetPhase !== 'error' ? (
        <Modal
          heading={t('reset_modal_heading')}
          closeLabel={tA11y('modal_close')}
          onClose={closePwdResetModal}
          onConfirm={pwdResetPhase === 'confirming' ? () => void handleConfirmPwdReset() : () => {}}
          confirmLabel={
            pwdResetPhase === 'resetting'
              ? t('reset_modal_resetting_button')
              : pwdResetPhase === 'restarting'
                ? t('reset_modal_restarting_button')
                : t('reset_modal_confirm_button')
          }
          cancelLabel={t('reset_modal_cancel_button')}
          confirmDisabled={pwdResetPhase !== 'confirming'}
          cancelDisabled={pwdResetPhase !== 'confirming'}
          danger
        >
          {pwdResetPhase === 'confirming' ? (
            <div className="gp-account-pwd-reset-modal">
              {/* baselineDiffers === true means bootEnv has a NON-empty
                  password value that the DB override is currently
                  shadowing. Resetting → mergeEnv falls back to that .env
                  baseline → server restarts with the OLD env password,
                  NOT unconfigured. The default copy claims "account
                  unconfigured / anyone can reach" — accurate when no
                  baseline, misleading when one exists. Pick the matching
                  variant so we don't scare users into adding a public-
                  exposure mitigation that isn't needed in their case. */}
              <p>
                {pwdState?.baselineDiffers === true
                  ? t('reset_modal_body_clear_with_baseline')
                  : t('reset_modal_body_clear')}
              </p>
              <p>{t('reset_modal_body_restart')}</p>
              {pwdState?.baselineDiffers === true ? (
                <p className="gp-account-pwd-reset-modal__hint">
                  {t('reset_modal_body_baseline_hint')}
                </p>
              ) : (
                <p className="gp-account-pwd-reset-modal__warn">
                  {t('reset_modal_body_security_warn')}
                </p>
              )}
            </div>
          ) : (
            <p className="gp-account-pwd-reset-modal__status">
              {pwdResetPhase === 'resetting'
                ? t('reset_modal_status_resetting')
                : t('reset_modal_status_restarting')}
            </p>
          )}
        </Modal>
      ) : null}
      {pwdResetPhase === 'error' ? (
        <Modal
          heading={t('reset_modal_heading')}
          closeLabel={tA11y('modal_close')}
          onClose={closePwdResetModal}
        >
          <div className="gp-account-pwd-reset-modal gp-account-pwd-reset-modal--error">
            <p className="gp-account-pwd-reset-modal__error">{pwdResetError}</p>
            <div className="gp-account-pwd-reset-modal__actions">
              <Btn sm kind="primary" onClick={closePwdResetModal}>
                {t('reset_modal_close_button')}
              </Btn>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
