import type { EnvKeyState, ImSettingsManifest } from '@goldpan/web-sdk';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import { INITIAL_MOCK } from '../settings-data';
import { GroupNotify } from './notify';

const manifest: ImSettingsManifest = {
  channelId: 'telegram',
  branding: { name: { en: 'Telegram', zh: 'Telegram' } },
  enable: {
    envKey: 'GOLDPAN_IM_TELEGRAM_ENABLED',
    label: { en: 'Enable Telegram', zh: '启用 Telegram' },
    default: false,
  },
  fields: [
    {
      name: 'botToken',
      kind: 'secret',
      label: { en: 'Bot token', zh: 'Bot Token' },
      envKey: 'GOLDPAN_IM_TELEGRAM_BOT_TOKEN',
      required: true,
    },
    {
      name: 'allowedChatIds',
      kind: 'text',
      label: { en: 'Allowed chat IDs', zh: '允许的 Chat ID' },
      envKey: 'GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS',
      required: true,
    },
  ],
  actions: [],
  setupGuide: { allDoneTitle: { en: 'Done', zh: '完成' }, steps: [] },
};

function item(key: string, mask: string): EnvKeyState {
  return { key, configured: true, source: 'env', mask };
}

const baseProps = {
  dirty: {},
  patch: vi.fn(),
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
  applyEnvItems: vi.fn(),
};

describe('GroupNotify', () => {
  test('treats legacy configured channel without explicit enable key as enabled', () => {
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <GroupNotify
          {...baseProps}
          language="zh"
          manifests={[manifest]}
          env={
            new Map([
              [
                'GOLDPAN_IM_TELEGRAM_ENABLED',
                {
                  key: 'GOLDPAN_IM_TELEGRAM_ENABLED',
                  configured: false,
                  source: 'default',
                  mask: '',
                },
              ],
              ['GOLDPAN_IM_TELEGRAM_BOT_TOKEN', item('GOLDPAN_IM_TELEGRAM_BOT_TOKEN', '••••1234')],
              [
                'GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS',
                item('GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS', '123456'),
              ],
            ])
          }
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByText('Bot Token')).toBeInTheDocument();
    expect(screen.getByText('允许的 Chat ID')).toBeInTheDocument();
  });
});
