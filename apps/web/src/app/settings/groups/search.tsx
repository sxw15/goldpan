'use client';

import type { PluginSettingsContributionDescriptor } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsHead } from '@/components/ui/settings-head';
import {
  PluginActionButton,
  PluginEnableInline,
  PluginFieldRow,
  PluginNoticesBlock,
  readLiveEnabled,
} from '../plugin-contribution-card';
import { PluginMeta } from '../plugin-meta';
import type { GroupProps } from '../settings-shell';
import { SetupGuide } from '../setup-guide';

type UsageEntry = readonly [code: string, descKey: string];

interface UsageSpec {
  kind: 'operators' | 'struct';
  items: readonly UsageEntry[];
  caveatKey?: string;
}

// Usage operators / structured-field cheat sheets live here, not in plugin
// contributions: they're long-form prose that benefits from web-side i18n +
// markdown structure, and don't belong to the plugin's runtime config.
// Lookup by pluginId; missing entry = no expandable usage section.
const GOOGLE_OPERATORS: readonly UsageEntry[] = [
  ['site:github.com 开源', 'usage_op_site_desc'],
  ['-site:reddit.com', 'usage_op_exclude_site_desc'],
  ['intitle:"机器学习"', 'usage_op_intitle_desc'],
  ['inurl:blog', 'usage_op_inurl_desc'],
  ['filetype:pdf', 'usage_op_filetype_desc'],
  ['"完整短语"', 'usage_op_exact_desc'],
  ['python -java', 'usage_op_exclude_desc'],
  ['python OR rust', 'usage_op_or_desc'],
  ['before:2024-01-01', 'usage_op_before_desc'],
  ['after:2023-01-01', 'usage_op_after_desc'],
];

const SERPER_OPERATORS: readonly UsageEntry[] = [
  ...GOOGLE_OPERATORS,
  ['intext:term', 'usage_op_intext_desc'],
  ['related:foo.com', 'usage_op_related_desc'],
  ['allintitle:foo bar', 'usage_op_allintitle_desc'],
];

const BRAVE_OPERATORS: readonly UsageEntry[] = [
  ['site:github.com 开源', 'usage_op_site_desc'],
  ['-site:reddit.com', 'usage_op_exclude_site_desc'],
  ['intitle:"机器学习"', 'usage_op_intitle_desc'],
  ['inbody:term', 'usage_op_inbody_desc'],
  ['ext:pdf', 'usage_op_ext_desc'],
  ['"完整短语"', 'usage_op_exact_desc'],
  ['python -java', 'usage_op_exclude_desc'],
  ['python OR rust', 'usage_op_or_desc'],
  ['python NOT java', 'usage_op_not_desc'],
];

const SEARXNG_OPERATORS: readonly UsageEntry[] = [
  ['site:reuters.com', 'usage_op_site_desc'],
  ['intitle:"keyword"', 'usage_op_intitle_desc'],
  ['inurl:blog', 'usage_op_inurl_desc'],
  ['filetype:pdf', 'usage_op_filetype_desc'],
  ['"完整短语"', 'usage_op_exact_desc'],
  ['!g python', 'usage_op_or_desc'],
];

const TAVILY_FIELDS: readonly UsageEntry[] = [
  ['includeDomains: ["arxiv.org"]', 'usage_field_include_domains_desc'],
  ['excludeDomains: ["reddit.com"]', 'usage_field_exclude_domains_desc'],
  ['startDate: "2024-01-01"', 'usage_field_start_date_desc'],
  ['endDate: "2024-03-31"', 'usage_field_end_date_desc'],
];

const EXA_FIELDS: readonly UsageEntry[] = [
  ['includeDomains: ["arxiv.org"]', 'usage_field_include_domains_desc'],
  ['excludeDomains: ["example.com"]', 'usage_field_exclude_domains_desc'],
  ['startPublishedDate: "2024-01-01T00:00:00Z"', 'usage_field_start_published_date_desc'],
  ['endPublishedDate: "2024-03-31T23:59:59Z"', 'usage_field_end_published_date_desc'],
];

const USAGE_BY_PLUGIN: Record<string, UsageSpec> = {
  'tool-search-google': {
    kind: 'operators',
    items: GOOGLE_OPERATORS,
    caveatKey: 'usage_caveat_google',
  },
  'tool-search-serper': {
    kind: 'operators',
    items: SERPER_OPERATORS,
    caveatKey: 'usage_caveat_serper',
  },
  'tool-search-brave': {
    kind: 'operators',
    items: BRAVE_OPERATORS,
    caveatKey: 'usage_caveat_brave',
  },
  'tool-search-searxng': {
    kind: 'operators',
    items: SEARXNG_OPERATORS,
    caveatKey: 'usage_caveat_searxng',
  },
  'tool-search-tavily': { kind: 'struct', items: TAVILY_FIELDS, caveatKey: 'usage_caveat_tavily' },
  'tool-search-exa': { kind: 'struct', items: EXA_FIELDS, caveatKey: 'usage_caveat_exa' },
};

/**
 * Filter contributions down to the search group. No client-side fallback list:
 * if the server reports zero search contributions, the plugin really is not
 * registered — showing fabricated rows would let the user fill in API keys,
 * `commitEnv` would accept them (the global MANAGED_ENV_KEYS whitelist covers
 * the well-known engine keys), but `executeToolWithFallback('search')` would
 * throw "No tool plugins registered for capability: search" at runtime. The
 * silent gap between "looks configured" and "actually unavailable" is worse
 * than an empty state that says "install a plugin first".
 */
// TEMP: 仅展示 Tavily，其余搜索引擎暂时从 UI 隐藏（plugin 本体仍注册，但
// 用户无法启用 / 配置）。恢复多个引擎时换回 `new Set([...])` 即可。
const VISIBLE_SEARCH_PLUGIN_ID = 'tool-search-tavily';

export function getEffectiveSearchContributions(
  contributions: PluginSettingsContributionDescriptor[],
): PluginSettingsContributionDescriptor[] {
  return contributions.filter(
    (c) => c.group === 'search' && c.pluginId === VISIBLE_SEARCH_PLUGIN_ID,
  );
}

function UsageDetails({
  kind,
  items,
  caveatKey,
}: {
  kind: 'operators' | 'struct';
  items: readonly UsageEntry[];
  caveatKey?: string;
}): ReactNode {
  const t = useTranslations('settings.search');
  return (
    <details className="gp-usage">
      <summary className="gp-usage__summary">{t('usage_summary')}</summary>
      <div className="gp-usage__body">
        <p className="gp-usage__intro">
          {t(kind === 'operators' ? 'usage_label_operators' : 'usage_label_struct')}
        </p>
        <ul className="gp-usage__list">
          {items.map(([code, descKey]) => (
            <li key={code}>
              <code>{code}</code>
              <span>— {t(descKey)}</span>
            </li>
          ))}
        </ul>
        {caveatKey ? <p className="gp-usage__caveat">{t(caveatKey)}</p> : null}
      </div>
    </details>
  );
}

export function GroupSearch(
  props: GroupProps & {
    contributions: PluginSettingsContributionDescriptor[];
    contributionsError?: string | null;
  },
) {
  const t = useTranslations('settings.search');
  const contributionsError = props.contributionsError ?? null;
  const searchContributions = getEffectiveSearchContributions(props.contributions);
  const isEmpty = searchContributions.length === 0;

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />
      <SettingsCard heading={t('card_engines_heading')} sub={t('card_engines_sub')}>
        {contributionsError !== null ? <p className="gp-muted">{contributionsError}</p> : null}
        {isEmpty && contributionsError === null ? (
          <p className="gp-muted">{t('empty_state')}</p>
        ) : null}
        {searchContributions.length > 0 ? (
          <div className="gp-search-engine-list">
            {searchContributions.map((contribution) => {
              const usage = USAGE_BY_PLUGIN[contribution.pluginId];
              return (
                <PluginGroupRows
                  key={contribution.pluginId}
                  contribution={contribution}
                  group={props}
                  usage={usage}
                />
              );
            })}
          </div>
        ) : null}
      </SettingsCard>
    </>
  );
}

function PluginGroupRows({
  contribution,
  group,
  usage,
}: {
  contribution: PluginSettingsContributionDescriptor;
  group: GroupProps;
  usage?: UsageSpec;
}) {
  // 每个引擎包一个 `.gp-search-engine-block`（仿 `.gp-llm-provider-block`），
  // 让 fields / actions 有明确归属。否则 Google 的 enable + 3 个 number
  // field 看起来与上下其它引擎的字段平级，用户分不清「每小时限额」属于谁。
  //
  // Usage cheat-sheet 仍然挂在 block 内的第一行 hint slot —— 第一行是
  // enable toggle（Google）或 first field（5 个 API-key 引擎）。block 顶部
  // 由 PluginMeta + SetupGuide 占据，所以 toggle / first field 的 label
  // 用各自的原 label（`enable.label` / `field.label`），不再借用品牌名占位。
  const usageAccordion =
    usage !== undefined ? (
      <UsageDetails kind={usage.kind} items={usage.items} caveatKey={usage.caveatKey} />
    ) : undefined;
  const enable = contribution.enable;
  // 折叠规则: 当 plugin 声明了 enable toggle 且 live=false 时,只渲染 plugin
  // meta 那一行 (toggle 已 inline 到右侧 trailing slot)。usage / fields /
  // actions / setupGuide 都隐藏 —— 关闭的插件不该把限速 / test 按钮等参数
  // 撑开占用视觉空间。notices 在 enable 之上仍然显示(notices 是"启用前
  // 必读"语义,折叠后等于看不到 warn,违背意图)。
  // 没有 enable toggle 的 plugin 视为始终展开。
  //
  // Optimistic state: seed `expanded` from env (readLiveEnabled), then
  // mirror PluginEnableInline's onLiveChange so the toggle and the
  // body/actions panel use ONE shared live value. Without this the
  // toggle visually flipped OFF while the body stayed visible for the
  // 100-300ms commit roundtrip (and remained visible forever on commit
  // error). Inline `live` is also reused by PluginActionButton's
  // disable check below.
  const initialLive =
    enable === undefined ? true : readLiveEnabled(enable.envKey, enable.default, group);
  const [live, setLive] = useState(initialLive);
  const expanded = enable === undefined || live;
  return (
    <div className="gp-search-engine-block">
      <PluginMeta
        name={contribution.branding.name}
        version={contribution.pluginVersion ?? '0.0.0'}
        description={contribution.pluginDescription}
        homepage={contribution.branding.homepage}
        trailing={
          enable !== undefined ? (
            <PluginEnableInline
              envKey={enable.envKey}
              label={enable.label}
              defaultValue={enable.default}
              group={group}
              onLiveChange={setLive}
            />
          ) : undefined
        }
      />
      {contribution.notices !== undefined && contribution.notices.length > 0 && (
        <PluginNoticesBlock notices={contribution.notices} />
      )}
      {expanded && contribution.setupGuide !== undefined && (
        <SetupGuide pluginId={contribution.pluginId} guide={contribution.setupGuide} />
      )}
      {expanded && (
        <div className="gp-search-engine-block__body">
          {usageAccordion !== undefined && (
            <div className="gp-search-engine-block__usage">{usageAccordion}</div>
          )}
          {contribution.fields.map((field) => (
            <PluginFieldRow key={field.name} field={field} group={group} />
          ))}
          {contribution.actions?.map((action) => (
            <PluginActionButton
              key={action.id}
              pluginId={contribution.pluginId}
              action={action}
              fields={contribution.fields}
              group={group}
            />
          ))}
        </div>
      )}
    </div>
  );
}
