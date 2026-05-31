'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Btn } from '@/components/ui/button';
import { SettingsField } from '@/components/ui/settings-field';
import { Toggle } from '@/components/ui/toggle';
import { useEditableCommit, useToggleCommit } from '@/components/ui/use-field-commit';
import type { GroupProps } from '../../settings-shell';
import { useFieldTagLabels } from '../../use-field-tag-labels';
import { ProviderModelsField } from './provider-models-field';

interface Props {
  group: GroupProps;
}

/**
 * Ollama 行：本地推理无 API key，复用 SecretRow 的 password 套路反而别扭。
 * value 槽放 baseURL 输入，control 槽放启用开关 + (per-key) 重置按钮。
 *
 * 「启用」开关 = `GOLDPAN_OLLAMA_ENABLED` env，决定 `/llm/providers` 是否把
 * ollama 标 `apiKeyConfigured: true` —— 因此也决定 Pipeline 下拉是否列出
 * ollama。默认 false：没装 daemon 的用户从此不再看到这个失败选项。
 *
 * Models 列表走通用 `ProviderModelsField`，env 键名 `GOLDPAN_LLM_PROVIDER_OLLAMA_MODELS`
 * 与其它 builtin 完全一致 —— Pipeline 下拉单一数据来源。
 */
export function OllamaRow({ group }: Props) {
  const t = useTranslations('settings.llm');
  const tActions = useTranslations('settings.actions');
  const fieldTagLabels = useFieldTagLabels();
  const [resettingUrl, setResettingUrl] = useState(false);
  const [resettingEnabled, setResettingEnabled] = useState(false);

  const urlState = group.env.get('OLLAMA_BASE_URL');
  const enabledState = group.env.get('GOLDPAN_OLLAMA_ENABLED');
  const urlHook = useEditableCommit({
    envKey: 'OLLAMA_BASE_URL',
    committed: urlState?.mask ?? '',
    commit: group.commit,
    fieldName: t('ollama_row_label'),
    baselineDiffers: urlState?.baselineDiffers,
    onEditingChange: (editing) => group.setFieldEditing('OLLAMA_BASE_URL', editing),
  });
  const enabledHook = useToggleCommit({
    envKey: 'GOLDPAN_OLLAMA_ENABLED',
    committed: enabledState?.mask ?? 'false',
    commit: group.commit,
    fieldName: t('ollama_enable_label'),
    baselineDiffers: enabledState?.baselineDiffers,
  });
  const enabledValue = enabledHook.current === 'true';

  return (
    <>
      <SettingsField
        tagLabels={fieldTagLabels}
        label={t('ollama_row_label')}
        hint={t('ollama_row_hint')}
        env="OLLAMA_BASE_URL"
        source={urlState?.source}
        baselineDiffers={urlState?.baselineDiffers}
        shadowed={urlState?.source === 'override' && urlState?.baselineDiffers === true}
        status={urlHook.status}
        onReset={
          urlState?.source === 'override' && urlHook.state !== 'saving'
            ? async () => {
                setResettingUrl(true);
                try {
                  const ok = await group.resetEnvKey('OLLAMA_BASE_URL');
                  if (ok) {
                    urlHook.clear();
                  } else {
                    urlHook.markError(tActions('reset_failed_inline'));
                  }
                } finally {
                  setResettingUrl(false);
                }
              }
            : undefined
        }
        resetting={resettingUrl}
        resetLabel={tActions('reset')}
        resetInProgressLabel={tActions('reset_in_progress')}
        resetTitle={tActions('reset_hint')}
        value={
          <input
            type="url"
            className="gp-sinput gp-sinput--mono"
            placeholder={t('ollama_baseurl_placeholder')}
            value={urlHook.draft}
            disabled={urlHook.state === 'saving'}
            onChange={(e) => urlHook.setDraft(e.target.value)}
            onBlur={() => {
              if (urlHook.dirty) void urlHook.save();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                // No blur — see collect.tsx FieldNumber for race rationale.
                urlHook.cancel();
              }
            }}
            aria-label={t('ollama_baseurl_aria')}
          />
        }
        control={
          <span className="gp-llm-step-row__toggle">
            <Toggle
              ariaLabel={t('ollama_enable_label')}
              on={enabledValue}
              disabled={enabledHook.state === 'saving'}
              onChange={(v) => {
                void enabledHook.fire(v ? 'true' : 'false');
              }}
            />
            <span>{t('ollama_enable_label')}</span>
            {enabledState?.source === 'override' && enabledHook.state !== 'saving' ? (
              <Btn
                sm
                kind="ghost"
                disabled={resettingEnabled}
                onClick={async () => {
                  setResettingEnabled(true);
                  try {
                    const ok = await group.resetEnvKey('GOLDPAN_OLLAMA_ENABLED');
                    if (ok) {
                      enabledHook.clear();
                    } else {
                      enabledHook.markError(tActions('reset_failed_inline'));
                    }
                  } finally {
                    setResettingEnabled(false);
                  }
                }}
              >
                {resettingEnabled ? tActions('reset_in_progress') : tActions('reset')}
              </Btn>
            ) : null}
          </span>
        }
      />
      <ProviderModelsField group={group} providerId="ollama" />
    </>
  );
}
