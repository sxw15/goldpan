import type {
  EnvKeyState,
  ImSettingsManifest,
  PluginSettingsContributionDescriptor,
} from '@goldpan/web-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import { INITIAL_MOCK } from '../settings-data';
import { GroupDigest } from './digest';

// digest plugin contribution declares two new env-backed fields:
//   GOLDPAN_DIGEST_DAILY_TIME (text)  +  GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE (number)
// `/settings/contributions` returns them but they were never wired into
// GroupDigest; users could not edit them in the UI. The fix renders both
// rows inside the `card_enable_heading` card when digest is enabled.
const digestContribution: PluginSettingsContributionDescriptor = {
  pluginId: 'digest',
  group: 'digest',
  branding: { name: 'Digest' },
  enable: { envKey: 'GOLDPAN_DIGEST_ENABLED', label: '启用日报', default: false },
  fields: [
    {
      name: 'dailyTime',
      kind: 'text',
      envKey: 'GOLDPAN_DIGEST_DAILY_TIME',
      label: '每日发送时间',
      placeholder: '09:00',
      // Mirror real digest plugin contribution: schema default (06:00) is
      // declared so the UI surfaces it on unconfigured rows. The actual
      // plugin keeps these in lockstep with core's config schema default;
      // tests recreate the same wiring.
      default: '06:00',
    },
    {
      name: 'maxItemsPerModule',
      kind: 'number',
      envKey: 'GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE',
      label: '每模块最多条目数',
      min: 1,
      max: 50,
      step: 1,
      default: 10,
    },
  ],
};

const telegramManifest: ImSettingsManifest = {
  channelId: 'telegram',
  branding: { name: { en: 'Telegram', zh: 'Telegram' } },
  enable: {
    envKey: 'GOLDPAN_IM_TELEGRAM_ENABLED',
    label: { en: 'Enable Telegram', zh: '启用 Telegram' },
    default: false,
  },
  fields: [],
  actions: [],
  setupGuide: { allDoneTitle: { en: 'Done', zh: '完成' }, steps: [] },
};

const baseProps = {
  env: new Map<string, EnvKeyState>([
    [
      'GOLDPAN_DIGEST_ENABLED',
      {
        key: 'GOLDPAN_DIGEST_ENABLED',
        configured: true,
        source: 'default' as const,
        mask: 'true',
      },
    ],
    [
      'GOLDPAN_DIGEST_DAILY_TIME',
      {
        key: 'GOLDPAN_DIGEST_DAILY_TIME',
        configured: false,
        source: 'default' as const,
        mask: '',
      },
    ],
    [
      'GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE',
      {
        key: 'GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE',
        configured: false,
        source: 'default' as const,
        mask: '',
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
  digestEnabled: true,
  presets: [],
  setPresets: vi.fn(),
  manifests: [] as ImSettingsManifest[],
  language: 'zh' as 'zh' | 'en',
};

function renderG(extra: Partial<typeof baseProps> = {}) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <GroupDigest {...baseProps} {...extra} contributions={[digestContribution]} />
    </NextIntlClientProvider>,
  );
}

describe('GroupDigest', () => {
  test('contribution 提供的 dailyTime + maxItemsPerModule 行渲染在 card_enable_heading 内', () => {
    renderG();
    // dailyTime 走 PluginFieldRow → SecretRow(plain) → 显示 label
    expect(screen.getByText('每日发送时间')).toBeInTheDocument();
    // maxItemsPerModule 走 PluginFieldRow → NumberFieldRow → number input
    expect(screen.getByText('每模块最多条目数')).toBeInTheDocument();
    // 数字 input 应能定位到（aria-label 用 field.label）
    expect(screen.getByLabelText('每模块最多条目数')).toBeInTheDocument();
  });

  test('未配置时显示 contribution 的 schema default 而不是空 / 未配置 (#O regression)', () => {
    // Pre-fix: server returns `mask: ''` for unconfigured (source='default')
    // keys. NumberFieldRow's `state?.mask ?? ''` didn't fall back on the
    // empty string, so users saw "—" while the runtime was actually using
    // schema default 10; SecretRow(plain) similarly read "未配置" while
    // the server was on 06:00. Post-fix the contribution carries `default`
    // (digest plugin declares it; core resolveField transports it), and
    // both renderers fall back to it on empty mask, so UI reflects the
    // actual runtime config.
    renderG();
    // dailyTime row's right-side value should be '06:00' (the declared
    // default), not the i18n "未配置" string.
    expect(screen.getByText('06:00')).toBeInTheDocument();
    // maxItemsPerModule right-side value shows the default 10. Note: the
    // input's `value` also reads '10' because NumberFieldRow seeds the
    // editable hook with the default — both reflect the same fact.
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  test('digest disabled 时不渲染 contribution fields(只显示 enable + DigestDisabledCard)', () => {
    renderG({ digestEnabled: false });
    expect(screen.queryByText('每日发送时间')).not.toBeInTheDocument();
    expect(screen.queryByText('每模块最多条目数')).not.toBeInTheDocument();
  });

  test('主分支 toggle 缺少前置条件时仍允许从 ON 关掉 (restart lockout regression)', () => {
    // Construct env where digest's summary step uses openai but the
    // OPENAI_API_KEY is unconfigured (digestEnableBlocked=true).
    const blockedEnv = new Map<string, EnvKeyState>([
      ...baseProps.env,
      [
        'GOLDPAN_LLM_DIGEST_SUMMARY',
        {
          key: 'GOLDPAN_LLM_DIGEST_SUMMARY',
          configured: true,
          source: 'default' as const,
          mask: 'openai:gpt-4o-mini',
        },
      ],
      [
        'OPENAI_API_KEY',
        {
          key: 'OPENAI_API_KEY',
          configured: false,
          source: 'default' as const,
          mask: '',
        },
      ],
    ]);
    const { container } = renderG({ env: blockedEnv });
    // Toggle 渲染为 button.gp-toggle，主页面的 GOLDPAN_DIGEST_ENABLED row 是
    // 唯一带 gp-toggle 类的元素（其它 toggle 是 plugin contribution）。
    const toggles = Array.from(
      container.querySelectorAll('button.gp-toggle'),
    ) as HTMLButtonElement[];
    expect(toggles.length).toBeGreaterThan(0);
    // 主页面入口 toggle 在第一个；已经 ON 时必须允许关掉，否则用户会被锁
    // 在一个缺 API key、但又关不掉 Digest 的状态里。
    expect(toggles[0]?.disabled).toBe(false);
  });

  test('contributions 缺失时,enabled 视图仍可渲染(不依赖 contribution 不抛错)', () => {
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <GroupDigest {...baseProps} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText('每日发送时间')).not.toBeInTheDocument();
    // enable toggle 仍可见(label 走 i18n 'settings.digest.field_digest_enabled_label'
    // —— 即"启用定时日报",不依赖 contribution.enable.label)
    expect(screen.getByText('启用定时日报')).toBeInTheDocument();
  });

  test('IM channel tab disables new preset entry points while presets are not implemented', () => {
    renderG({
      env: new Map<string, EnvKeyState>([
        ...baseProps.env,
        [
          'GOLDPAN_IM_TELEGRAM_ENABLED',
          {
            key: 'GOLDPAN_IM_TELEGRAM_ENABLED',
            configured: true,
            source: 'override' as const,
            mask: 'true',
          },
        ],
      ]),
      manifests: [telegramManifest],
    });

    fireEvent.click(screen.getByRole('button', { name: /Telegram/ }));

    for (const button of screen.getAllByRole('button', { name: /新建预设/ })) {
      expect(button).toBeDisabled();
    }
  });
});
