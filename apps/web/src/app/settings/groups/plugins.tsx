'use client';

import type { PluginInfo, PluginsSnapshot, PluginType } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { Btn } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsHead } from '@/components/ui/settings-head';
import { useEnvMappingVisible } from '../env-mapping-visibility';
import type { GroupProps } from '../settings-shell';

interface Props extends GroupProps {
  pluginsSnapshot: PluginsSnapshot;
}

const TYPE_ORDER: PluginType[] = ['collector', 'intent', 'tool', 'llm-provider'];

export function GroupPlugins({ pluginsSnapshot, navigateToGroup }: Props) {
  const t = useTranslations('settings.plugins');

  const grouped = new Map<PluginType, PluginInfo[]>();
  for (const ty of TYPE_ORDER) grouped.set(ty, []);
  for (const p of pluginsSnapshot.plugins) {
    grouped.get(p.type)?.push(p);
  }

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />

      <Notice kind="info" icon="ⓘ">
        {t.rich('header_notice', {
          imLink: (chunks) => <a href="?group=notify">{chunks}</a>,
        })}
      </Notice>

      <SettingsCard heading={t('card_installed')}>
        <div className="gp-plugins__type-list">
          {TYPE_ORDER.map((ty) => {
            const list = grouped.get(ty) ?? [];
            if (list.length === 0) return null;
            return (
              <div key={ty} className="gp-plugins__type-block">
                <div className="gp-plugins__type-block__head">
                  <span className="gp-plugins__type-block__name">
                    {t(`type_${ty.replace('-', '_')}`)}
                  </span>
                  <span className="gp-plugins__type-count">{list.length}</span>
                </div>
                <div className="gp-plugins__type-block__body">
                  {list.map((p) => (
                    <PluginRow key={p.name} plugin={p} t={t} navigateToGroup={navigateToGroup} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard heading={t('card_install')}>
        <Notice kind="info" icon="ⓘ">
          {t('placeholder_banner')}
        </Notice>
        <Btn sm disabled>
          {t('install_button')}
        </Btn>
        <div className="gp-plugins__manual-install">
          <h4>{t('manual_install_heading')}</h4>
          <ol>
            <li>{t('manual_install_step1')}</li>
            <li>{t('manual_install_step2')}</li>
            <li>{t('manual_install_step3')}</li>
          </ol>
          <p>{t('manual_install_steps')}</p>
        </div>
      </SettingsCard>

      <p className="gp-plugins__footer-troubleshoot">{t('footer_troubleshoot')}</p>
    </>
  );
}

interface PluginRowProps {
  plugin: PluginInfo;
  t: ReturnType<typeof useTranslations>;
  navigateToGroup: GroupProps['navigateToGroup'];
}

function PluginRow({ plugin, t, navigateToGroup }: PluginRowProps) {
  // Destructure first so the conditional below narrows `configGroup` to a
  // non-null const, which the click handler can capture without `!`. The
  // closure runs after render, so reading `plugin.configGroup` lazily would
  // lose the narrow.
  const { configGroup } = plugin;
  const envMappingVisible = useEnvMappingVisible();
  return (
    <div className="gp-plugin-row">
      <div className="gp-plugin-row__left">
        <span className="gp-plugin-row__name">{plugin.displayName}</span>
      </div>

      <div className="gp-plugin-row__middle">
        <p className="gp-plugin-row__desc">{plugin.description}</p>
        {envMappingVisible && plugin.envKeys.length > 0 && (
          <ul className="gp-plugin-row__envkeys">
            {plugin.envKeys.map((k) => (
              <li key={k.key}>
                <span
                  className={`gp-envkey-dot gp-envkey-dot--${k.configured ? 'ok' : 'missing'}`}
                  data-test-envkey-dot={k.configured ? 'configured' : 'missing'}
                />
                <code>{k.key}</code>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="gp-plugin-row__right">
        {plugin.status !== 'loaded' && (
          <span className="gp-status-badge" data-status={plugin.status} title={plugin.error}>
            {t(`status_${plugin.status}`)}
          </span>
        )}
        {configGroup && (
          <button
            type="button"
            className="gp-btn"
            data-variant="secondary"
            data-size="sm"
            onClick={() => navigateToGroup(configGroup)}
          >
            {t('config_button')}
          </button>
        )}
      </div>
    </div>
  );
}
