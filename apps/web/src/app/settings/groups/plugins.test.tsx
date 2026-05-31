import type { PluginsSnapshot } from '@goldpan/web-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import { EnvMappingVisibilityProvider } from '../env-mapping-visibility';
import { GroupPlugins } from './plugins';

function makeSnapshot(): PluginsSnapshot {
  // Plugin `name` is the slug (PluginRegistry-registered, the same key used by
  // PLUGIN_CONFIG_GROUP_MAP), NOT the npm package name — see
  // apps/server/src/routes/plugin-config-group-map.ts header. Mock data must
  // reflect this.
  return {
    plugins: [
      {
        name: 'collector-browser',
        displayName: 'collector-browser',
        version: '0.1.0',
        description: 'Headless Chromium collector',
        type: 'collector',
        status: 'loaded',
        envKeys: [
          { key: 'GOLDPAN_BROWSER_STRATEGY', configured: true },
          { key: 'GOLDPAN_BROWSER_EXECUTABLE_PATH', configured: false },
        ],
        configGroup: 'collect',
      },
      {
        name: 'tracking',
        displayName: 'tracking',
        version: '0.2.0',
        description: 'Keyword tracking scheduler',
        type: 'intent',
        status: 'loaded',
        envKeys: [],
      },
      {
        name: 'tool-search-tavily',
        displayName: 'tool-search-tavily',
        version: '0.1.0',
        description: 'Tavily search tool',
        type: 'tool',
        status: 'loaded',
        envKeys: [{ key: 'TAVILY_API_KEY', configured: true }],
        configGroup: 'search',
      },
    ],
    registryInstallSupported: false,
  };
}

function makeProps(
  snapshot: PluginsSnapshot = makeSnapshot(),
  overrides: { navigateToGroup?: ReturnType<typeof vi.fn> } = {},
) {
  return {
    env: new Map(),
    dirty: {},
    patch: vi.fn(),
    applyEnvItems: vi.fn(),
    reset: vi.fn(),
    resetEnvKey: vi.fn(async () => true),
    resetEnvKeyAndRestart: vi.fn(async () => ({ kind: 'success' as const })),
    save: vi.fn(),
    commit: vi.fn(async () => ({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] })),
    inFlightKeys: new Set<string>(),
    mock: {} as never,
    updateMock: vi.fn(),
    toast: vi.fn(),
    navigateToGroup: overrides.navigateToGroup ?? vi.fn(),
    setFieldEditing: vi.fn(),
    pluginsSnapshot: snapshot,
  } as Parameters<typeof GroupPlugins>[0];
}

function renderG(
  snapshot?: PluginsSnapshot,
  overrides: {
    navigateToGroup?: ReturnType<typeof vi.fn>;
    /** 模拟 SettingsShell 顶部的 .env 映射开关。默认 true 让 envKey 状态 dot
     * 测试看见列表；envKey 隐藏路径由 settings-shell.test 单独覆盖。 */
    envMappingVisible?: boolean;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <EnvMappingVisibilityProvider visible={overrides.envMappingVisible ?? true}>
        <GroupPlugins {...makeProps(snapshot, overrides)} />
      </EnvMappingVisibilityProvider>
    </NextIntlClientProvider>,
  );
}

describe('GroupPlugins', () => {
  test('按 type 分组渲染', () => {
    renderG();
    // displayName 在 .gp-plugin-row__name <span> 里，version 紧跟其后；
    // 用更具体的查询定位 plugin 行（避免 description 里的 "tracking" 等
    // 同名子串造成多匹配）。
    expect(
      screen.getByText(
        (_, el) =>
          el?.classList.contains('gp-plugin-row__name') === true &&
          el.textContent?.startsWith('collector-browser') === true,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) =>
          el?.classList.contains('gp-plugin-row__name') === true &&
          el.textContent?.startsWith('tracking') === true,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) =>
          el?.classList.contains('gp-plugin-row__name') === true &&
          el.textContent?.startsWith('tool-search-tavily') === true,
      ),
    ).toBeInTheDocument();
  });

  test('envKey 状态 dot：configured=true 渲染绿点 / false 渲染灰点', () => {
    renderG();
    const greenDots = document.querySelectorAll('[data-test-envkey-dot="configured"]');
    const grayDots = document.querySelectorAll('[data-test-envkey-dot="missing"]');
    expect(greenDots.length).toBe(2);
    expect(grayDots.length).toBe(1);
  });

  test('configGroup 存在的 plugin 渲染配置按钮，点击触发 navigateToGroup（SPA 跳转，避免 full reload）', () => {
    const navigateToGroup = vi.fn();
    renderG(undefined, { navigateToGroup });
    // 'config_button' (zh) = '配置'。改成 button + onClick 而非 anchor href，
    // 因为 anchor 会触发 full page reload 并重置 server-component fetch +
    // dirty state。SPA 跳转走 settings-shell 的 requestNavigate。
    const configBtns = screen.getAllByRole('button', { name: '配置' });
    expect(configBtns).toHaveLength(2);
    fireEvent.click(configBtns[0]);
    expect(navigateToGroup).toHaveBeenLastCalledWith('collect');
    fireEvent.click(configBtns[1]);
    expect(navigateToGroup).toHaveBeenLastCalledWith('search');
  });

  test('顶部 Notice 包含 IM 引导链接', () => {
    renderG();
    // i18n im_redirect = '通知'
    const imLink = screen.getByRole('link', { name: '通知' });
    expect(imLink).toHaveAttribute('href', '?group=notify');
  });

  test('底部 footer "装了没出现" 链接', () => {
    renderG();
    expect(screen.getByText(/常见原因/)).toBeInTheDocument();
  });

  test('安装新插件 card 显示 disabled 按钮 + 手动安装说明', () => {
    renderG();
    const installBtn = screen.getByRole('button', { name: /Registry/i });
    expect(installBtn).toBeDisabled();
    expect(screen.getByText(/详见 README/)).toBeInTheDocument();
  });

  test('failed 状态的 plugin 渲染 status badge + error tooltip', () => {
    const snap: PluginsSnapshot = {
      plugins: [
        {
          name: '@goldpan/plugin-llm-cohere',
          displayName: 'llm-cohere',
          version: '0.1.0',
          description: 'Cohere provider',
          type: 'llm-provider',
          status: 'failed',
          error: 'API key missing',
          envKeys: [],
        },
      ],
      registryInstallSupported: false,
    };
    renderG(snap);
    expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    // error 通过 title attribute 暴露（tooltip）
    const badge = document.querySelector('[data-status="failed"]') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('title')).toBe('API key missing');
  });
});
