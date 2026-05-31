import type { EnvKeyState } from '@goldpan/web-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../messages/zh.json';
import { PluginActionButton, PluginEnableToggle, PluginFieldRow } from './plugin-contribution-card';
import { INITIAL_MOCK } from './settings-data';
import type { GroupProps } from './settings-shell';

const invokeContributionAction = vi.fn();

vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({ invokeContributionAction }),
}));

function group(overrides: Partial<GroupProps> = {}): GroupProps {
  const env = new Map<string, EnvKeyState>([
    ['API_KEY', { key: 'API_KEY', configured: true, source: 'env', mask: 'old-masked-value' }],
    ['MODE', { key: 'MODE', configured: true, source: 'env', mask: 'quick' }],
  ]);
  return {
    env,
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
    ...overrides,
  };
}

function renderWithI18n(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('plugin contribution card primitives', () => {
  test('invokes action with empty payload — auto-commit means typed values already landed on server', async () => {
    // Pre-auto-commit this test verified `dirty: {API_KEY: 'new-key'}` got
    // forwarded into the action handler so the plugin could test the just-
    // typed value before save. Now every keystroke auto-commits via
    // commitEnv, so the server already has the value at the moment Test
    // clicks; the action handler reads env directly and the payload is `{}`.
    invokeContributionAction.mockResolvedValueOnce({ ok: true });
    const props = group({});

    renderWithI18n(
      <PluginActionButton
        pluginId="demo"
        action={{ id: 'test', kind: 'test', label: 'Test', requires: ['apiKey'] }}
        fields={[{ name: 'apiKey', kind: 'secret', envKey: 'API_KEY', label: 'API Key' }]}
        group={props}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));

    await waitFor(() => expect(invokeContributionAction).toHaveBeenCalledWith('demo', 'test', {}));
  });

  test('uses enable default when no env or dirty value exists', () => {
    renderWithI18n(
      <PluginEnableToggle
        envKey="DEFAULT_ON"
        label="Default Engine"
        defaultValue
        group={group()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Default Engine' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('uses enable default when env-state reports an unconfigured empty mask', () => {
    const props = group({
      env: new Map([
        ['DEFAULT_ON', { key: 'DEFAULT_ON', configured: false, source: 'default', mask: '' }],
      ]),
    });

    renderWithI18n(
      <PluginEnableToggle envKey="DEFAULT_ON" label="Default Engine" defaultValue group={props} />,
    );

    expect(screen.getByRole('button', { name: 'Default Engine' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('enable toggle exposes reset for runtime overrides', () => {
    const resetEnvKey = vi.fn(async () => true);
    renderWithI18n(
      <PluginEnableToggle
        envKey="GOOGLE_ENABLED"
        label="Google"
        group={group({
          resetEnvKey,
          env: new Map([
            [
              'GOOGLE_ENABLED',
              { key: 'GOOGLE_ENABLED', configured: true, source: 'override', mask: 'true' },
            ],
          ]),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重置' }));

    expect(resetEnvKey).toHaveBeenCalledWith('GOOGLE_ENABLED');
  });

  test('number field exposes reset for runtime overrides', () => {
    const resetEnvKey = vi.fn(async () => true);
    renderWithI18n(
      <PluginFieldRow
        field={{ name: 'limit', kind: 'number', envKey: 'LIMIT', label: 'Hourly limit' }}
        group={group({
          resetEnvKey,
          env: new Map([
            ['LIMIT', { key: 'LIMIT', configured: true, source: 'override', mask: '20' }],
          ]),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重置' }));

    expect(resetEnvKey).toHaveBeenCalledWith('LIMIT');
  });

  test('labels number and segmented controls for assistive technology', () => {
    renderWithI18n(
      <>
        <PluginFieldRow
          field={{ name: 'limit', kind: 'number', envKey: 'LIMIT', label: 'Hourly limit' }}
          group={group()}
        />
        <PluginFieldRow
          field={{
            name: 'mode',
            kind: 'segmented',
            envKey: 'MODE',
            label: 'Mode',
            options: [{ value: 'quick', label: 'Quick' }],
          }}
          group={group()}
        />
      </>,
    );

    expect(screen.getByRole('spinbutton', { name: 'Hourly limit' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
  });
});
