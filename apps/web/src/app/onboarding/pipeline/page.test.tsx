import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import type { WizardState } from '../_components/wizard-state';
import PipelinePage from './page';

const ctx = vi.hoisted(() => {
  const value: {
    state: WizardState;
    push: ReturnType<typeof vi.fn<(path: string) => void>>;
  } = { state: { providers: {}, steps: {} }, push: vi.fn() };
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
      availableProviders: [],
    }),
    useWizardNavigate: () => (path: string) => ctx.push(path),
  };
});

function renderPage(state: WizardState) {
  ctx.state = state;
  ctx.push.mockClear();
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <PipelinePage />
    </NextIntlClientProvider>,
  );
}

describe('<PipelinePage>', () => {
  test('does not allow next when required models are provider-only ids', () => {
    renderPage({
      providers: {
        openai: { apiKey: 'sk', models: [] },
      },
      steps: {
        classifier: { model: 'openai:' },
        extractor: { model: 'openai:gpt-4o-mini' },
        matcher: { model: 'openai:gpt-4o-mini' },
        comparator: { model: 'openai:gpt-4o-mini' },
        intent: { model: 'openai:gpt-4o-mini' },
        query: { model: 'openai:gpt-4o-mini' },
      },
    });

    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
  });

  test('allows next when all required models have provider and model ids', () => {
    renderPage({
      providers: {
        openai: { apiKey: 'sk', models: ['gpt-4o-mini'] },
      },
      steps: {
        classifier: { model: 'openai:gpt-4o-mini' },
        extractor: { model: 'openai:gpt-4o-mini' },
        matcher: { model: 'openai:gpt-4o-mini' },
        comparator: { model: 'openai:gpt-4o-mini' },
        intent: { model: 'openai:gpt-4o-mini' },
        query: { model: 'openai:gpt-4o-mini' },
      },
    });

    const next = screen.getByRole('button', { name: '下一步' });
    expect(next).toBeEnabled();
    fireEvent.click(next);
    // embedding 在 _components/steps.ts 已标记 hidden，pipeline 之后直接进 im。
    expect(ctx.push).toHaveBeenCalledWith('/onboarding/im');
  });
});
