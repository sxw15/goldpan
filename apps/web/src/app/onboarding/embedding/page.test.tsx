import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import type { AvailableProvider, WizardState } from '../_components/wizard-state';
import EmbeddingPage from './page';

const ctx = vi.hoisted(() => {
  const value: {
    state: WizardState;
    availableProviders: AvailableProvider[];
    push: ReturnType<typeof vi.fn<(path: string) => void>>;
  } = {
    state: { providers: {}, steps: {} },
    availableProviders: [],
    push: vi.fn(),
  };
  return value;
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: ctx.push }),
}));

vi.mock('../_components/wizard-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_components/wizard-state')>();
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
    useWizardNavigate: () => (path: string) => ctx.push(path),
  };
});

function renderPage(state: WizardState, availableProviders: AvailableProvider[] = []): void {
  ctx.state = state;
  ctx.availableProviders = availableProviders;
  ctx.push.mockClear();
  render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <EmbeddingPage />
    </NextIntlClientProvider>,
  );
}

describe('<EmbeddingPage>', () => {
  test('Next is enabled when embedding disabled, regardless of model', () => {
    // 关闭时 model 是否填齐都不影响 —— 用户主动跳过 embedding 不应被卡住。
    renderPage({ providers: {}, steps: {}, embedding: { enabled: false } });
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
  });

  test('Next is disabled when embedding enabled but model is missing', () => {
    renderPage({ providers: {}, steps: {}, embedding: { enabled: true } });
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
  });

  test('Next is disabled when embedding enabled and model is half-formed (`provider:`)', () => {
    // 半成品 `'cohere:'` 落到 .env 会让 loadConfig 时 modelIdSchema 抛错，
    // server 起不来 —— 这是 commit 里 silent failure 的根因。
    renderPage(
      {
        providers: {},
        steps: {},
        embedding: { enabled: true, model: 'cohere:' },
      },
      [{ id: 'cohere', source: 'plugin', models: [], embeddingModels: ['embed-v3'] }],
    );
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
  });

  test('Next is enabled with complete provider:model', () => {
    renderPage(
      {
        providers: {},
        steps: {},
        embedding: { enabled: true, model: 'cohere:embed-v3' },
      },
      [{ id: 'cohere', source: 'plugin', models: [], embeddingModels: ['embed-v3'] }],
    );
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
  });

  test('model dropdown for env-only plugin provider falls back to availableProviders.embeddingModels', () => {
    // M1 核心场景：用户在 .env 配 plugin provider 的 _EMBEDDING_MODELS，
    // 但没在 wizard 走过 —— state.providers 没条目，必须 fallback 到 server
    // snapshot 才能让用户在下拉里选到 model。
    renderPage(
      {
        providers: {},
        steps: {},
        embedding: { enabled: true, model: 'cohere:embed-v3' },
      },
      [
        {
          id: 'cohere',
          source: 'plugin',
          models: [],
          embeddingModels: ['embed-v3', 'embed-v3-light'],
        },
      ],
    );
    const modelSelect = screen.getByLabelText(/Embedding 模型/i) as HTMLSelectElement;
    const opts = within(modelSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain('embed-v3');
    expect(opts).toContain('embed-v3-light');
  });
});
