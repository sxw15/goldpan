'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Btn } from '@/components/ui/button';
import { SettingsCard } from '@/components/ui/settings-card';
import type { GroupProps } from '../../settings-shell';
import { AddBuiltinProviderModal } from './add-builtin-provider-modal';
import { AddOpenAICompatModal } from './add-openai-compat-modal';
import { AddPluginTutorialModal } from './add-plugin-tutorial-modal';
import type { BuiltinProviderMeta } from './builtin-providers';

interface Props {
  group: GroupProps;
  /** Forwarded to add modals — see their `onSaved` doc. */
  onProviderSaved?: () => void;
  /**
   * Builtins not yet configured. Each renders as a `+ {label}` button that
   * opens `AddBuiltinProviderModal` with the right meta. Already-configured
   * builtins are filtered out by the parent so users can't double-add.
   */
  unconfiguredBuiltins: BuiltinProviderMeta[];
  /**
   * 全部 provider id 集合（builtin + custom + plugin），转给 OpenAI-compat add
   * modal 做 id 查重。Server commitEnv 是按 env key 直接覆盖，不会因 id 重复
   * 拒绝请求，UI 不挡就会静默覆盖 baseUrl / apiKeyEnv / models。
   */
  existingIds: ReadonlySet<string>;
}

type OpenModal =
  | { kind: 'builtin'; meta: BuiltinProviderMeta }
  | { kind: 'openai-compat' }
  | { kind: 'plugin' }
  | null;

export function AddProviderCard({
  group,
  onProviderSaved,
  unconfiguredBuiltins,
  existingIds,
}: Props) {
  const t = useTranslations('settings.llm');
  const [openModal, setOpenModal] = useState<OpenModal>(null);

  return (
    <>
      <SettingsCard heading={t('add_card_heading')} sub={t('add_card_desc')}>
        <div className="gp-add-provider-actions">
          {unconfiguredBuiltins.map((meta) => (
            <Btn
              key={meta.id}
              kind="primary"
              onClick={() => setOpenModal({ kind: 'builtin', meta })}
            >
              {t('add_btn_builtin', { provider: meta.label })}
            </Btn>
          ))}
          <Btn kind="ghost" onClick={() => setOpenModal({ kind: 'openai-compat' })}>
            {t('add_btn_openai_compat')}
          </Btn>
          <Btn kind="ghost" onClick={() => setOpenModal({ kind: 'plugin' })}>
            {t('add_btn_plugin')}
          </Btn>
        </div>
      </SettingsCard>
      {openModal?.kind === 'builtin' ? (
        <AddBuiltinProviderModal
          group={group}
          meta={openModal.meta}
          onClose={() => setOpenModal(null)}
          onSaved={onProviderSaved}
        />
      ) : null}
      {openModal?.kind === 'openai-compat' ? (
        <AddOpenAICompatModal
          group={group}
          onClose={() => setOpenModal(null)}
          onSaved={onProviderSaved}
          existingIds={existingIds}
        />
      ) : null}
      {openModal?.kind === 'plugin' ? (
        <AddPluginTutorialModal onClose={() => setOpenModal(null)} />
      ) : null}
    </>
  );
}
