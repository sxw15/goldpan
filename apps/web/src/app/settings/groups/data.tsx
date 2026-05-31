'use client';

import { useTranslations } from 'next-intl';
import { Btn } from '@/components/ui/button';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsField } from '@/components/ui/settings-field';
import { SettingsHead } from '@/components/ui/settings-head';
import { Toggle } from '@/components/ui/toggle';
import type { GroupProps } from '../settings-shell';
import { useFieldTagLabels } from '../use-field-tag-labels';

export function GroupData({ mock, toast }: GroupProps) {
  const t = useTranslations('settings.data');
  const tShell = useTranslations('settings.shell');
  const fieldTagLabels = useFieldTagLabels();
  const { data } = mock;

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />
      <SettingsCard heading={t('card_storage')}>
        <SettingsField
          tagLabels={fieldTagLabels}
          // DB path is in `.env.example` as `GOLDPAN_DB_SQLITE_PATH` but NOT in
          // MANAGED_ENV_KEYS (settings UI can't write it). Show env tag for
          // discoverability + readonly + todo.
          label={t('field_db_path_label')}
          env="GOLDPAN_DB_SQLITE_PATH"
          readonly
          todo
          value={t('field_db_path_value')}
          valueInk
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_db_size_label')}
          hint={t('field_db_size_hint')}
          todo
          value={t('field_db_size_value', { size: data.dbSize })}
          valueInk
          control={
            <Btn sm disabled>
              {t('vacuum_button')}
            </Btn>
          }
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_cache_label')}
          hint={t('field_cache_hint')}
          todo
          value={t('field_cache_value', { size: data.cacheSize })}
          control={
            <Btn sm disabled>
              {t('cache_clear_button')}
            </Btn>
          }
        />
      </SettingsCard>
      <SettingsCard
        heading={t('card_backup_heading')}
        sub={t('card_backup_sub', { when: data.lastBackup, file: data.lastBackupFile })}
        right={
          <div className="gp-shead__actions">
            <Btn sm disabled>
              {t('backup_now_button')}
            </Btn>
            <Btn sm disabled>
              {t('restore_button')}
            </Btn>
          </div>
        }
      >
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_auto_backup_label')}
          hint={t('field_auto_backup_hint')}
          todo
          value={data.autoBackup ? t('auto_backup_on') : t('auto_backup_off')}
          control={
            <Toggle on={data.autoBackup} onChange={() => toast({ msg: tShell('unimplemented') })} />
          }
        />
      </SettingsCard>
      <SettingsCard heading={t('card_export_danger')}>
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_export_all_label')}
          hint={t('field_export_all_hint')}
          todo
          control={
            <Btn sm disabled>
              {t('export_button')}
            </Btn>
          }
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_clear_log_label')}
          hint={t('field_clear_log_hint')}
          todo
          value={t('field_clear_log_value')}
          control={
            <Btn sm kind="danger" disabled>
              {t('clear_log_button')}
            </Btn>
          }
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_reset_label')}
          hint={t('field_reset_hint')}
          todo
          control={
            <Btn sm kind="danger" disabled>
              {t('reset_button')}
            </Btn>
          }
        />
      </SettingsCard>
    </>
  );
}
