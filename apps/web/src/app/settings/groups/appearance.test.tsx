import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import zh from '../../../../messages/zh.json';
import { INITIAL_MOCK } from '../settings-data';
import { GroupAppearance } from './appearance';

const baseProps = {
  env: new Map([
    [
      'GOLDPAN_LANGUAGE',
      { key: 'GOLDPAN_LANGUAGE', configured: true, source: 'env' as const, mask: 'zh' },
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
      <ThemeProvider>
        <GroupAppearance {...props} />
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
}

describe('GroupAppearance', () => {
  test('language select does NOT render ja option', () => {
    renderG();
    const langSelect = screen
      .getAllByRole('combobox')
      .find((el) =>
        Array.from(el.querySelectorAll('option')).some((o) => o.getAttribute('value') === 'zh'),
      ) as HTMLSelectElement;
    expect(langSelect).toBeDefined();
    const values = Array.from(langSelect.querySelectorAll('option')).map((o) => o.value);
    expect(values).toContain('zh');
    expect(values).toContain('en');
    expect(values).not.toContain('ja');
  });

  test('changing language fires auto-commit for GOLDPAN_LANGUAGE', () => {
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] });
    renderG({ ...baseProps, commit });
    const langSelect = screen
      .getAllByRole('combobox')
      .find((el) =>
        Array.from(el.querySelectorAll('option')).some((o) => o.getAttribute('value') === 'zh'),
      ) as HTMLSelectElement;
    fireEvent.change(langSelect, { target: { value: 'en' } });
    expect(commit).toHaveBeenCalledWith({ GOLDPAN_LANGUAGE: 'en' });
  });

  test('density Segmented click fires unimplemented toast and does NOT commit', () => {
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] });
    const toast = vi.fn();
    renderG({ ...baseProps, commit, toast });
    // The density segmented is a button group — find one labelled "紧凑"
    fireEvent.click(screen.getByRole('button', { name: '紧凑' }));
    expect(toast).toHaveBeenCalled();
    const arg = toast.mock.calls.at(-1)?.[0];
    expect(arg?.msg).toBe('暂未实装，仅作占位');
    expect(commit).not.toHaveBeenCalled();
  });

  test('theme Segmented click does NOT commit (live, localStorage)', () => {
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] });
    renderG({ ...baseProps, commit });
    fireEvent.click(screen.getByRole('button', { name: '深色' }));
    expect(commit).not.toHaveBeenCalled();
    // Theme reflected in <html data-theme>
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
