import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import { StepCard } from './step-card';
import type { AvailableProvider, WizardState } from './wizard-state';

// Hoisted holder so each test can swap the wizard ctx the mocked useWizard
// returns. vi.mock factory runs before module initialization, so we can't
// close over a let directly — vi.hoisted gives us a stable reference.
const ctx = vi.hoisted(() => {
  const value: {
    state: WizardState;
    availableProviders: AvailableProvider[];
  } = { state: { providers: {}, steps: {} }, availableProviders: [] };
  return value;
});

vi.mock('./wizard-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wizard-state')>();
  return {
    ...actual,
    useWizard: () => ({
      state: ctx.state,
      patch: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      hydrated: true,
      patchError: null,
      dismissError: vi.fn(),
      availableProviders: ctx.availableProviders,
    }),
  };
});

function renderCard(state: WizardState, availableProviders: AvailableProvider[]) {
  ctx.state = state;
  ctx.availableProviders = availableProviders;
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <StepCard stepKey="classifier" />
    </NextIntlClientProvider>,
  );
}

describe('StepCard two-stage provider/model selection', () => {
  it('only lists configured builtin providers + custom/plugin from availableProviders', () => {
    renderCard(
      {
        providers: { openai: { apiKey: 'sk-x', models: ['gpt-4o-mini'] } },
        steps: {},
      },
      [{ id: 'together', source: 'custom', models: ['llama-3.3-70b'], embeddingModels: [] }],
    );
    const providerSelect = screen.getByLabelText(/Provider$/) as HTMLSelectElement;
    const opts = within(providerSelect).getAllByRole('option') as HTMLOptionElement[];
    const values = opts.map((o) => o.value);
    // Configured + custom show up.
    expect(values).toContain('openai');
    expect(values).toContain('together');
    // Unconfigured builtins (anthropic / google / deepseek / openrouter / ollama) MUST NOT
    // appear — they're added via the «Add Provider» card, not selectable here.
    for (const id of ['anthropic', 'google', 'deepseek', 'openrouter', 'ollama']) {
      expect(values, `unconfigured ${id} must be absent`).not.toContain(id);
    }
  });

  it('shows the «add a provider above first» placeholder when no provider is configured', () => {
    renderCard({ providers: {}, steps: {} }, []);
    const providerSelect = screen.getByLabelText(/Provider$/) as HTMLSelectElement;
    expect(providerSelect.disabled).toBe(true);
    // Placeholder option carries the «请先在上方添加 Provider» copy.
    const placeholder = within(providerSelect).getAllByRole('option')[0] as HTMLOptionElement;
    expect(placeholder.textContent).toMatch(/上方添加|Add a provider/);
  });

  it('renders plugin provider id with raw label (no _label translation)', () => {
    renderCard({ providers: {}, steps: {} }, [
      { id: 'cohere', source: 'plugin', models: [], embeddingModels: [] },
    ]);
    const providerSelect = screen.getByLabelText(/Provider$/);
    const opt = within(providerSelect)
      .getAllByRole('option')
      .find((o) => (o as HTMLOptionElement).value === 'cohere');
    expect(opt).toBeDefined();
    expect(opt?.textContent ?? '').toMatch(/^cohere/);
  });

  it('populates the model select from state.providers[id].models when provider is selected', () => {
    renderCard(
      {
        providers: { openai: { apiKey: 'sk-x', models: ['gpt-4o-mini', 'gpt-4o'] } },
        steps: { classifier: { model: 'openai:gpt-4o-mini' } },
      },
      [],
    );
    const modelSelect = screen.getByLabelText(/^.*的模型$/);
    const options = within(modelSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('gpt-4o-mini');
    expect(options).toContain('gpt-4o');
  });

  it('populates external provider model options from availableProviders', () => {
    renderCard(
      {
        providers: {},
        steps: { classifier: { model: 'cohere:command-r-plus' } },
      },
      [
        {
          id: 'cohere',
          source: 'plugin',
          models: ['command-r-plus', 'command-r'],
          embeddingModels: [],
        },
      ],
    );
    const modelSelect = screen.getByLabelText(/^.*的模型$/);
    const options = within(modelSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('command-r-plus');
    expect(options).toContain('command-r');
  });

  it('disables the model select with "no models" hint when provider models are empty', () => {
    renderCard(
      {
        providers: { ollama: { baseUrl: 'http://localhost:11434', models: [] } },
        steps: { classifier: { model: 'ollama:' } },
      },
      [],
    );
    const modelSelect = screen.getByLabelText(/^.*的模型$/) as HTMLSelectElement;
    // 永远 select、永不退回 input。空 models 时 disable + 提示用户回 Provider 设置补 model。
    expect(modelSelect.tagName).toBe('SELECT');
    expect(modelSelect.disabled).toBe(true);
    expect(screen.getByText(/Provider 还没有 model/)).toBeInTheDocument();
  });

  it('renders off-list legacy model as a fallback `value · ?` option', () => {
    // openai.models = ['gpt-4o-mini']，但 cfg.model 指向 `gpt-3-legacy`（off-list）。
    // 期望 select.value 仍能匹配该值（通过 fallback option），用户能看到现状再重选。
    renderCard(
      {
        providers: { openai: { apiKey: 'sk-x', models: ['gpt-4o-mini'] } },
        steps: { classifier: { model: 'openai:gpt-3-legacy' } },
      },
      [],
    );
    const modelSelect = screen.getByLabelText(/^.*的模型$/) as HTMLSelectElement;
    expect(modelSelect.tagName).toBe('SELECT');
    expect(modelSelect.value).toBe('gpt-3-legacy');
  });
});
