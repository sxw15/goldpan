'use client';

import type { ImSettingsManifest } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useFieldTagLabels } from '@/app/settings/use-field-tag-labels';
import { ImChannelCard } from '@/components/im-channel-card';
import { Btn } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { SettingsHead } from '@/components/ui/settings-head';
import {
  isLastVisibleStep,
  nextVisibleHref,
  prevVisibleHref,
  visibleIndex,
  visibleTotal,
} from '../_components/steps';
import { formatErrorPath, useWizardCommit } from '../_components/use-wizard-commit';
import { useWizard, useWizardNavigate } from '../_components/wizard-state';

export function ImPageClient({ manifests }: { manifests: ImSettingsManifest[] }) {
  const t = useTranslations('onboarding.im');
  const tAuth = useTranslations('onboarding.auth');
  const tt = useTranslations('onboarding');
  const tProgress = useTranslations('onboarding.progress');
  const fieldTagLabels = useFieldTagLabels();
  const nav = useWizardNavigate();
  const { state, patch } = useWizard();
  const language = state.language ?? 'en';
  // IM is currently the last *visible* config step — render 提交配置 instead
  // of 下一步. If steps.ts ever puts another visible step after IM, this flips
  // back to a nav button automatically.
  const isCommitStep = isLastVisibleStep('im');
  const { commit, committing, submitFailed, validationErrors } = useWizardCommit();

  return (
    <>
      <SettingsHead
        crumb={tProgress('step_n_of_total', {
          current: visibleIndex('im'),
          total: visibleTotal(),
        })}
        heading={t('section_title')}
        desc={t('intro_hint')}
      />

      {manifests.map((manifest) => {
        const channelState = state.im?.[manifest.channelId];
        // Respect manifest.enable.default — plugin决定渠道默认是否打开。同时和
        // settings/notify.tsx 的 fallback 链对齐（settings 用 manifest.enable.default
        // 作 fresh-state fallback），避免 wizard 默认 OFF / settings 默认 ON 的不
        // 一致。一旦用户在 wizard 显式 toggle 过，channelState.enabled 就被设置，
        // 后续以用户选择为准。
        const values: { __enabled?: boolean } & Record<string, string | boolean | undefined> = {
          __enabled: channelState?.enabled ?? manifest.enable.default,
        };
        for (const f of manifest.fields) {
          // Wizard state stores fields as strings (env-serialized form).
          // For toggles, parse 'true'/'false' back to boolean — ImChannelCard's
          // FieldRenderer does `<Toggle on={!!value}/>`, so a raw string would
          // collapse 'false' to true. Mirror of T25 fix in settings/notify.tsx.
          const raw = channelState?.fields?.[f.name];
          if (f.kind === 'toggle') {
            values[f.name] =
              raw === 'true' ? true : raw === 'false' ? false : (f.default as boolean | undefined);
          } else {
            values[f.name] = raw ?? '';
          }
        }
        return (
          <ImChannelCard
            key={manifest.channelId}
            manifest={manifest}
            mode="wizard"
            language={language}
            values={values}
            tagLabels={fieldTagLabels}
            toast={() => {}}
            disableActions
            onChange={(name, value) => {
              if (name === '__enabled') {
                patch({
                  im: {
                    ...(state.im ?? {}),
                    [manifest.channelId]: {
                      ...(channelState ?? {}),
                      enabled: !!value,
                    },
                  },
                });
              } else {
                // ImChannelCard emits boolean for toggle, string for
                // text/secret/segmented. Wizard state stores everything as
                // strings — serialize toggle to 'true'/'false' so the round-
                // trip through env (and the parse logic above) stays uniform.
                const serialized = typeof value === 'boolean' ? (value ? 'true' : 'false') : value;
                const fields = {
                  ...(channelState?.fields ?? {}),
                  [name]: serialized,
                };
                patch({
                  im: {
                    ...(state.im ?? {}),
                    [manifest.channelId]: {
                      ...(channelState ?? {}),
                      fields,
                    },
                  },
                });
              }
            }}
          />
        );
      })}

      {validationErrors && (
        <Notice kind="warn" heading={tAuth('validation_failed_title')}>
          <p>{tAuth('validation_failed_body')}</p>
          <ul className="gp-onboarding-errors">
            {validationErrors.map((e) => (
              // path + message together is a stable identity for a Zod issue.
              <li key={`${formatErrorPath(e.path) || 'err'}::${e.message ?? ''}`}>
                <code>{formatErrorPath(e.path)}</code>: {e.message ?? ''}
              </li>
            ))}
          </ul>
          <p className="gp-onboarding-errors-back">{tAuth('validation_back_to_edit')}</p>
        </Notice>
      )}
      {submitFailed && (
        <Notice kind="warn" heading={tAuth('submit_failed_title')}>
          {tAuth('submit_failed_body')}
        </Notice>
      )}

      <div className="gp-onboarding__actions gp-onboarding__actions--split">
        <Btn kind="ghost" onClick={() => nav(prevVisibleHref('im'))}>
          {tt('back_button')}
        </Btn>
        {isCommitStep ? (
          <Btn kind="primary" disabled={committing} onClick={commit}>
            {committing ? tAuth('submitting') : tAuth('submit_button')}
          </Btn>
        ) : (
          <Btn kind="primary" onClick={() => nav(nextVisibleHref('im'))}>
            {tt('next_button')}
          </Btn>
        )}
      </div>
    </>
  );
}
