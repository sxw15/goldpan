import type { PluginSettingsContributionDescriptor } from '@goldpan/web-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import { INITIAL_MOCK } from '../settings-data';
import { GroupCollect } from './collect';

const baseProps = {
  env: new Map([
    [
      'GOLDPAN_COLLECT_TIMEOUT',
      {
        key: 'GOLDPAN_COLLECT_TIMEOUT',
        configured: true,
        source: 'default' as const,
        mask: '30',
      },
    ],
    [
      'GOLDPAN_BROWSER_STRATEGY',
      {
        key: 'GOLDPAN_BROWSER_STRATEGY',
        configured: true,
        source: 'default' as const,
        mask: 'auto',
      },
    ],
    [
      'GOLDPAN_BROWSER_EXECUTABLE_PATH',
      {
        key: 'GOLDPAN_BROWSER_EXECUTABLE_PATH',
        configured: false,
        source: 'default' as const,
        mask: '',
      },
    ],
    [
      'GOLDPAN_MEDIA_COLLECT_TIMEOUT',
      {
        key: 'GOLDPAN_MEDIA_COLLECT_TIMEOUT',
        configured: true,
        source: 'default' as const,
        mask: '90',
      },
    ],
    [
      'GOLDPAN_YT_DLP_AUTO_UPDATE',
      {
        key: 'GOLDPAN_YT_DLP_AUTO_UPDATE',
        configured: true,
        source: 'default' as const,
        mask: 'true',
      },
    ],
    [
      'GOLDPAN_YT_DLP_BINARY_PATH',
      {
        key: 'GOLDPAN_YT_DLP_BINARY_PATH',
        configured: false,
        source: 'default' as const,
        mask: '',
      },
    ],
    [
      'GOLDPAN_YT_DLP_COOKIES_PATH',
      {
        key: 'GOLDPAN_YT_DLP_COOKIES_PATH',
        configured: false,
        source: 'default' as const,
        mask: '',
      },
    ],
    [
      'GOLDPAN_GITHUB_TOKEN',
      {
        key: 'GOLDPAN_GITHUB_TOKEN',
        configured: false,
        source: 'default' as const,
        mask: '',
      },
    ],
    [
      'GOLDPAN_MAX_CONTENT_LENGTH',
      {
        key: 'GOLDPAN_MAX_CONTENT_LENGTH',
        configured: true,
        source: 'default' as const,
        mask: '30000',
      },
    ],
    [
      'GOLDPAN_MIN_CONTENT_LENGTH',
      {
        key: 'GOLDPAN_MIN_CONTENT_LENGTH',
        configured: true,
        source: 'default' as const,
        mask: '50',
      },
    ],
    [
      'GOLDPAN_MAX_TEXT_INPUT_LENGTH',
      {
        key: 'GOLDPAN_MAX_TEXT_INPUT_LENGTH',
        configured: true,
        source: 'default' as const,
        mask: '20000',
      },
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

function renderG(props = baseProps) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <GroupCollect {...props} />
    </NextIntlClientProvider>,
  );
}

describe('GroupCollect', () => {
  test('渲染 5 个 SettingsCard（全局 / 内容长度 / Browser / Media / GitHub）', () => {
    renderG();
    expect(screen.getByRole('heading', { name: '全局' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '内容长度' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Browser 采集器' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Media 采集器（yt-dlp）' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'GitHub' })).toBeInTheDocument();
  });

  test('改 GOLDPAN_BROWSER_STRATEGY select 触发 commit', () => {
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] });
    renderG({ ...baseProps, commit });
    const select = screen
      .getAllByRole('combobox')
      .find((el) =>
        Array.from(el.querySelectorAll('option')).some((o) => o.getAttribute('value') === 'auto'),
      ) as HTMLSelectElement;
    expect(select).toBeDefined();
    fireEvent.change(select, { target: { value: 'bundled' } });
    expect(commit).toHaveBeenCalledWith({ GOLDPAN_BROWSER_STRATEGY: 'bundled' });
  });

  test('改 GOLDPAN_COLLECT_TIMEOUT input + blur 触发 commit', () => {
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] });
    renderG({ ...baseProps, commit });
    const input = screen.getByDisplayValue('30') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '60' } });
    // useEditableCommit only flushes on blur (or Enter) — typing alone is
    // tracked as draft, not yet committed.
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledWith({ GOLDPAN_COLLECT_TIMEOUT: '60' });
  });

  test('按 Escape 不触发 commit（F3 race regression）', () => {
    // F3 regression marker. The race only manifests in real browsers
    // (jsdom's `input.blur()` from inside a keyDown handler doesn't
    // reliably re-enter onBlur within the same event tick — see the
    // identical caveat noted in ImChannelCard.TextSecretField), so this
    // test cannot bidirectionally prove the bug. It guards against
    // regressions that would obviously re-add commit fires from the
    // Escape path: e.g. someone explicitly calling hook.save() inside
    // the Escape branch.
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] });
    renderG({ ...baseProps, commit });
    const input = screen.getByDisplayValue('30') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(commit).not.toHaveBeenCalled();
  });

  test('8 个 restart-required collect 字段都渲染 "改后需重启" tag（内容长度 3 个热更字段不计）', () => {
    // collect.tsx 渲染 7 个 restart Field* + 1 个 SecretRow（GitHub token）=
    // 8 个 STATIC_RESTART_REQUIRED_KEYS 字段，每行必带 "改后需重启"。
    // 内容长度卡片的 3 个字段（MAX/MIN_CONTENT、MAX_TEXT_INPUT）走 hot path
    // （读 ctx.config 即时生效），不在该白名单 —— 故标记数仍是 8 而非 11。
    // 回归保护：早期 PR 漏给 SecretRow 传 restart="restart"，导致 GitHub token
    // 行视觉上看起来 live，但 commit 后实际会拉起 restart prompt。
    renderG();
    const restartTags = screen.getAllByText('改后需重启');
    expect(restartTags).toHaveLength(8);
  });

  test('内容长度卡片的 3 个字段是热更：渲染默认值且不带 "改后需重启" tag', () => {
    renderG();
    // 每个字段以 envKey 小写作为 aria-label 渲染一个 number input。
    expect(screen.getByLabelText('goldpan_max_content_length')).toHaveValue(30000);
    expect(screen.getByLabelText('goldpan_min_content_length')).toHaveValue(50);
    expect(screen.getByLabelText('goldpan_max_text_input_length')).toHaveValue(20000);
    // 热更字段不增加 restart tag 总数（仍为 8，见上一条测试）。
    expect(screen.getAllByText('改后需重启')).toHaveLength(8);
  });

  test('内容长度跨字段约束报错按 code 本地化内联显示（不漏原始英文）', async () => {
    // The content-length fields auto-commit per-field; their inline error path
    // (pickErrorForField) only carries `message`. The collect.tsx commit wrapper
    // localizes the cross-field `code` before the field renders it.
    const commit = vi.fn(async () => ({
      kind: 'errors' as const,
      errors: [
        {
          path: '',
          code: 'content_length_min_exceeds_max',
          message: 'Min content length (99999) must not exceed max content length (30000)',
        },
      ],
    }));
    // Cast: baseProps.commit is narrowly inferred as ok-only; this test needs the
    // errors branch (runtime behavior is what's asserted).
    renderG({ ...baseProps, commit: commit as unknown as typeof baseProps.commit });
    const input = screen.getByLabelText('goldpan_min_content_length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '99999' } });
    fireEvent.blur(input);
    expect(await screen.findByText(/内容长度下限不能大于上限/)).toBeInTheDocument();
    // The raw English fallback must NOT leak into the localized UI.
    expect(screen.queryByText(/Min content length/)).not.toBeInTheDocument();
  });

  test('当 github-collector contribution 提供 setupGuide + test action 时,card_github 内渲染它们', () => {
    // 回归保护：早期 PR 把 contributions 只接到 GroupSearch,collector-github
    // 的 setupGuide / test action 被服务端返回但前端不渲染。修复后这两块必
    // 须出现在 card_github 内。
    const githubContribution: PluginSettingsContributionDescriptor = {
      pluginId: 'collector-github',
      group: 'collect',
      branding: { name: 'GitHub Collector' },
      fields: [
        {
          name: 'token',
          kind: 'secret',
          envKey: 'GOLDPAN_GITHUB_TOKEN',
          label: 'Personal Access Token',
          requiresRestart: true,
        },
      ],
      actions: [{ id: 'test', kind: 'test', label: '测试 token', requires: ['token'] }],
      setupGuide: {
        steps: [
          {
            id: 'create_pat',
            title: 'Create a Personal Access Token',
            desc: '在 github.com/settings/tokens 创建。',
          },
        ],
      },
    };
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <GroupCollect {...baseProps} contributions={[githubContribution]} />
      </NextIntlClientProvider>,
    );
    // setupGuide 的 summary 用 i18n key 'plugin_card.setup_guide'，渲染为可
    // 展开折叠的 <summary>；只要能找到它就证明 SetupGuide 渲染了。
    expect(screen.getByText('接入指南')).toBeInTheDocument();
    // test action 按钮 label 'fields[0].label' 取自 action.label
    expect(screen.getByRole('button', { name: '测试 token' })).toBeInTheDocument();
  });

  test('contributions 为空 / undefined 时,card_github 仍只显示 SecretRow,不抛错', () => {
    renderG(); // 不传 contributions
    expect(screen.queryByText('接入指南')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '测试 token' })).not.toBeInTheDocument();
  });
});
