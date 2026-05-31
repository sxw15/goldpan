import type { PluginSettingsContributionDescriptor } from '@goldpan/web-sdk';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import { INITIAL_MOCK } from '../settings-data';
import { GroupSearch } from './search';

// Stand-in contributions covering the 6 engines the live server would
// return — enough to assert the "all live, no restart needed" property
// without booting a real PluginRegistry.
const SEARCH_CONTRIBUTIONS: PluginSettingsContributionDescriptor[] = [
  {
    pluginId: 'tool-search-tavily',
    group: 'search',
    branding: { name: 'Tavily' },
    fields: [{ name: 'apiKey', kind: 'secret', envKey: 'TAVILY_API_KEY', label: 'API Key' }],
  },
  {
    pluginId: 'tool-search-exa',
    group: 'search',
    branding: { name: 'Exa' },
    fields: [{ name: 'apiKey', kind: 'secret', envKey: 'EXA_API_KEY', label: 'API Key' }],
  },
  {
    pluginId: 'tool-search-serper',
    group: 'search',
    branding: { name: 'Serper' },
    fields: [{ name: 'apiKey', kind: 'secret', envKey: 'SERPER_API_KEY', label: 'API Key' }],
  },
  {
    pluginId: 'tool-search-brave',
    group: 'search',
    branding: { name: 'Brave Search' },
    fields: [{ name: 'apiKey', kind: 'secret', envKey: 'BRAVE_SEARCH_API_KEY', label: 'Token' }],
  },
  {
    pluginId: 'tool-search-searxng',
    group: 'search',
    branding: { name: 'SearXNG' },
    fields: [{ name: 'baseUrl', kind: 'text', envKey: 'SEARXNG_BASE_URL', label: 'Base URL' }],
  },
  {
    pluginId: 'tool-search-google',
    group: 'search',
    branding: { name: 'Google' },
    enable: {
      envKey: 'GOLDPAN_GOOGLE_SEARCH_ENABLED',
      label: 'Enable Google search',
      default: false,
    },
    fields: [
      {
        name: 'hourlyLimit',
        kind: 'number',
        envKey: 'GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT',
        label: 'Hourly limit',
      },
      {
        name: 'delayMinMs',
        kind: 'number',
        envKey: 'GOLDPAN_GOOGLE_SEARCH_DELAY_MIN_MS',
        label: 'Min delay (ms)',
      },
      {
        name: 'delayMaxMs',
        kind: 'number',
        envKey: 'GOLDPAN_GOOGLE_SEARCH_DELAY_MAX_MS',
        label: 'Max delay (ms)',
      },
    ],
  },
];

const baseProps = {
  env: new Map([
    [
      'TAVILY_API_KEY',
      { key: 'TAVILY_API_KEY', configured: false, source: 'default' as const, mask: '' },
    ],
    [
      'SERPER_API_KEY',
      { key: 'SERPER_API_KEY', configured: false, source: 'default' as const, mask: '' },
    ],
  ]),
  dirty: {},
  patch: vi.fn(),
  applyEnvItems: vi.fn(),
  reset: vi.fn(),
  resetEnvKey: vi.fn(async () => true),
  resetEnvKeyAndRestart: vi.fn(async () => ({ kind: 'success' as const })),
  save: vi.fn(),
  commit: vi.fn(async () => ({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] })),
  inFlightKeys: new Set<string>(),
  mock: INITIAL_MOCK,
  updateMock: vi.fn(),
  toast: vi.fn(),
  navigateToGroup: vi.fn(),
  setFieldEditing: vi.fn(),
};

function renderG(contributions = SEARCH_CONTRIBUTIONS) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <GroupSearch {...baseProps} contributions={contributions} />
    </NextIntlClientProvider>,
  );
}

describe('GroupSearch', () => {
  test('search engine contributions do not show restart-required title tags', () => {
    renderG();
    // executeTool 时按需读 process.env，配合 ConfigStore.commit 同步更新
    // process.env，无需重启即可热更 —— UI 不再展示「即时生效」chip，只保留无「改后需重启」。
    expect(screen.queryAllByText('改后需重启')).toHaveLength(0);
    expect(screen.getByText('Tavily')).toBeInTheDocument();
    // TEMP: 与 search.tsx 的 VISIBLE_SEARCH_PLUGINS 白名单对齐，目前只展示
    // Tavily，其余搜索引擎暂时隐藏。恢复全部引擎时把下行换回
    // `expect(screen.getByText('Google')).toBeInTheDocument();` 即可。
    expect(screen.queryByText('Google')).not.toBeInTheDocument();
  });

  test('renders empty state when server reports zero search contributions', () => {
    renderG([]);

    // No fabricated plugin rows — the empty-state message is the only content.
    expect(screen.queryByText('Tavily')).not.toBeInTheDocument();
    expect(screen.queryByText('Google')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Hourly limit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
    expect(screen.getByText(/尚未注册任何搜索插件/)).toBeInTheDocument();
  });

  test('surfaces contributionsError without falling back to fake rows', () => {
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <GroupSearch {...baseProps} contributions={[]} contributionsError="network down" />
      </NextIntlClientProvider>,
    );

    expect(screen.queryByText('Tavily')).not.toBeInTheDocument();
    expect(screen.queryByText('Google')).not.toBeInTheDocument();
    expect(screen.getByText(/network down/)).toBeInTheDocument();
  });
});
