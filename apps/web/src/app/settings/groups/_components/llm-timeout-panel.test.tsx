import type { EnvKeyState } from '@goldpan/web-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../../messages/zh.json';
import { EnvMappingVisibilityProvider } from '../../env-mapping-visibility';
import { LlmTimeoutPanel } from './llm-timeout-panel';

function buildEnv(entries: Array<[string, string, 'env' | 'override' | 'default']>) {
  const m = new Map<string, EnvKeyState>();
  for (const [k, v, source] of entries) {
    m.set(k, { key: k, configured: true, source, mask: v });
  }
  return m;
}

function renderPanel(
  props: Partial<Parameters<typeof LlmTimeoutPanel>[0]>,
  { open = false }: { open?: boolean } = {},
) {
  const defaults = {
    env: buildEnv([['GOLDPAN_LLM_TIMEOUT', '600', 'default']]),
    commit: vi
      .fn()
      .mockResolvedValue({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] }),
    resetEnvKey: vi.fn(async () => true),
    setFieldEditing: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  const ui = render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <EnvMappingVisibilityProvider visible={true}>
        <LlmTimeoutPanel {...merged} />
      </EnvMappingVisibilityProvider>
    </NextIntlClientProvider>,
  );
  // <details> elements default to closed in jsdom; open programmatically when
  // the test needs to interact with the advanced section without simulating
  // the disclosure click (still goes through the same DOM, just bypasses the
  // summary's native click handler which jsdom toggles on click anyway).
  if (open) {
    const details = ui.container.querySelector('details.gp-llm-timeout-advanced');
    if (details) (details as HTMLDetailsElement).open = true;
  }
  return { ...ui, commit: merged.commit, resetEnvKey: merged.resetEnvKey };
}

describe('LlmTimeoutPanel · global timeout', () => {
  test('renders the global timeout input with the current env value', () => {
    renderPanel({
      env: buildEnv([['GOLDPAN_LLM_TIMEOUT', '45', 'env']]),
    });
    const input = screen.getByRole('spinbutton', { name: '全局超时' }) as HTMLInputElement;
    expect(input.value).toBe('45');
  });

  test('editing the global input commits GOLDPAN_LLM_TIMEOUT on blur (not per-keystroke)', () => {
    // Pre-fix: every keystroke fired commit — typing "120" produced 3
    // server writes ('1' / '12' / '120'), each of which the shell sent
    // through a full commitEnv roundtrip while the user kept typing,
    // causing input value to oscillate. Post-fix the input uses
    // useEditableCommit — keystrokes update the local draft; commit
    // fires once on blur.
    const { commit } = renderPanel({});
    const input = screen.getByRole('spinbutton', { name: '全局超时' });
    fireEvent.change(input, { target: { value: '90' } });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledWith({ GOLDPAN_LLM_TIMEOUT: '90' });
  });

  test('reset button only shows when global is an override', async () => {
    const { resetEnvKey } = renderPanel({
      env: buildEnv([['GOLDPAN_LLM_TIMEOUT', '60', 'override']]),
    });
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(resetEnvKey).toHaveBeenCalledWith('GOLDPAN_LLM_TIMEOUT');
  });

  test('default source hides the reset button', () => {
    renderPanel({
      env: buildEnv([['GOLDPAN_LLM_TIMEOUT', '600', 'default']]),
    });
    expect(screen.queryByRole('button', { name: '重置' })).toBeNull();
  });
});

describe('LlmTimeoutPanel · per-step overrides', () => {
  test('summary count reads "全部走全局" when no overrides exist', () => {
    renderPanel({});
    expect(screen.getByText('全部走全局')).toBeInTheDocument();
  });

  test('summary count reflects how many steps have an override', () => {
    renderPanel({
      env: buildEnv([
        ['GOLDPAN_LLM_TIMEOUT', '600', 'default'],
        ['GOLDPAN_LLM_EXTRACTOR_TIMEOUT', '90', 'override'],
        ['GOLDPAN_LLM_MATCHER_TIMEOUT', '60', 'override'],
      ]),
    });
    expect(screen.getByText(/已自定义.*2.*项/)).toBeInTheDocument();
  });

  test('per-step row uses the effective global value as placeholder', () => {
    renderPanel(
      {
        env: buildEnv([['GOLDPAN_LLM_TIMEOUT', '45', 'env']]),
      },
      { open: true },
    );
    const input = screen.getByRole('spinbutton', {
      name: /extractor.*超时/i,
    }) as HTMLInputElement;
    expect(input.placeholder).toBe('45');
  });

  test('editing a per-step input commits the timeout env key on blur', () => {
    // Per-step rows use the same blur-on-commit pattern as the global row.
    const { commit } = renderPanel({}, { open: true });
    const input = screen.getByRole('spinbutton', { name: /extractor.*超时/i });
    fireEvent.change(input, { target: { value: '120' } });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledWith({ GOLDPAN_LLM_EXTRACTOR_TIMEOUT: '120' });
  });

  test('reset on a per-step row removes the override', async () => {
    const { resetEnvKey } = renderPanel(
      {
        env: buildEnv([
          ['GOLDPAN_LLM_TIMEOUT', '600', 'default'],
          ['GOLDPAN_LLM_EXTRACTOR_TIMEOUT', '90', 'override'],
        ]),
      },
      { open: true },
    );
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(resetEnvKey).toHaveBeenCalledWith('GOLDPAN_LLM_EXTRACTOR_TIMEOUT');
  });

  test('out-of-range value triggers the invalid hint', () => {
    renderPanel(
      {
        env: buildEnv([
          ['GOLDPAN_LLM_TIMEOUT', '600', 'default'],
          ['GOLDPAN_LLM_EXTRACTOR_TIMEOUT', '999', 'override'],
        ]),
      },
      { open: true },
    );
    expect(screen.getAllByText(/1.*600/).length).toBeGreaterThan(0);
  });
});
