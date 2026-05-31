import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../../messages/zh.json';
import { INITIAL_MOCK } from '../../settings-data';
import { AddProviderCard } from './add-provider-card';

vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({ commitEnv: vi.fn() }),
}));

const baseGroup = {
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
  mock: INITIAL_MOCK,
  updateMock: vi.fn(),
  toast: vi.fn(),
  navigateToGroup: vi.fn(),
  setFieldEditing: vi.fn(),
};

function renderCard() {
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      {/* unconfiguredBuiltins=[] means only the OpenAI-compat / plugin entry
          buttons are rendered — keeps these tests focused on the existing
          flows; coverage for builtin add buttons lives in a dedicated test. */}
      <AddProviderCard group={baseGroup} unconfiguredBuiltins={[]} existingIds={new Set()} />
    </NextIntlClientProvider>,
  );
}

describe('AddProviderCard', () => {
  test('clicking the primary action opens the OpenAI-compat form modal', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: '添加 OpenAI 兼容 Provider' }));
    // Form-modal heading appears
    expect(screen.getByText('添加 OpenAI 兼容 provider')).toBeInTheDocument();
    // Form fields present
    expect(screen.getByPlaceholderText('together')).toBeInTheDocument();
  });

  test('clicking the docs link opens the plugin tutorial modal', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: '查看自定义插件文档' }));
    expect(screen.getByText('编写插件')).toBeInTheDocument();
    // Step headings render
    expect(screen.getByText('什么时候需要写插件')).toBeInTheDocument();
    expect(screen.getByText('实现 goldpanPlugin')).toBeInTheDocument();
  });
});
