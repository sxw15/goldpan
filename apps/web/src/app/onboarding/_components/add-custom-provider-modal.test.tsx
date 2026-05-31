import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../messages/zh.json';
import { AddCustomProviderModal } from './add-custom-provider-modal';
import type { AvailableProvider, WizardState } from './wizard-state';

const ctx = vi.hoisted(() => {
  const value: {
    state: WizardState;
    availableProviders: AvailableProvider[];
    patch: ReturnType<typeof vi.fn>;
  } = {
    state: { providers: {}, steps: {} },
    availableProviders: [],
    patch: vi.fn(async () => undefined),
  };
  return value;
});

vi.mock('./wizard-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wizard-state')>();
  return {
    ...actual,
    useWizard: () => ({
      state: ctx.state,
      patch: ctx.patch,
      flush: vi.fn(async () => undefined),
      hydrated: true,
      patchError: null,
      dismissError: vi.fn(),
      availableProviders: ctx.availableProviders,
    }),
  };
});

function renderModal() {
  ctx.state = { providers: {}, steps: {} };
  ctx.availableProviders = [];
  ctx.patch.mockClear();
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <AddCustomProviderModal onClose={vi.fn()} />
    </NextIntlClientProvider>,
  );
}

describe('AddCustomProviderModal', () => {
  test('rejects dash ids because they cannot round-trip through env keys', async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText('together'), {
      target: { value: 'together-ai' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://api.together.xyz/v1'), {
      target: { value: 'https://api.together.xyz/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: 'sk' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/必须以字母开头.*仅允许小写字母/)).toBeInTheDocument();
    expect(ctx.patch).not.toHaveBeenCalled();
  });

  test('rejects ids already discovered from external providers', async () => {
    ctx.availableProviders = [
      { id: 'cohere', source: 'plugin', models: ['command-r-plus'], embeddingModels: [] },
    ];
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <AddCustomProviderModal onClose={vi.fn()} />
      </NextIntlClientProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText('together'), { target: { value: 'cohere' } });
    fireEvent.change(screen.getByPlaceholderText('https://api.together.xyz/v1'), {
      target: { value: 'https://api.cohere.ai/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: 'sk' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/Provider id 已存在/)).toBeInTheDocument();
    expect(ctx.patch).not.toHaveBeenCalled();
  });

  test('accepts an underscore id that does not collide', async () => {
    const onClose = vi.fn();
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <AddCustomProviderModal onClose={onClose} />
      </NextIntlClientProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText('together'), {
      target: { value: 'together_ai' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://api.together.xyz/v1'), {
      target: { value: 'https://api.together.xyz/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••'), { target: { value: 'sk' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(ctx.patch).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});
