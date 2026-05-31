import type { CommitEnvResult, EnvKeyState } from '@goldpan/web-sdk';
import { fireEvent, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test, vi } from 'vitest';
import zh from '../../../../../messages/zh.json';
import type { GroupProps } from '../../settings-shell';
import { ProviderModelsField } from './provider-models-field';

function buildEnv(models: string, embedModels = ''): Map<string, EnvKeyState> {
  const m = new Map<string, EnvKeyState>();
  m.set('GOLDPAN_LLM_PROVIDER_OPENAI_MODELS', {
    key: 'GOLDPAN_LLM_PROVIDER_OPENAI_MODELS',
    configured: true,
    source: 'env',
    mask: models,
  });
  m.set('GOLDPAN_LLM_PROVIDER_OPENAI_EMBEDDING_MODELS', {
    key: 'GOLDPAN_LLM_PROVIDER_OPENAI_EMBEDDING_MODELS',
    configured: true,
    source: 'env',
    mask: embedModels,
  });
  return m;
}

function makeGroup(overrides: Partial<GroupProps>, models: string, embedModels = ''): GroupProps {
  return {
    env: buildEnv(models, embedModels),
    dirty: {},
    patch: vi.fn(),
    applyEnvItems: vi.fn(),
    reset: vi.fn(),
    resetEnvKey: vi.fn(async () => true),
    resetEnvKeyAndRestart: vi.fn(async () => ({ kind: 'success' as const })),
    save: vi.fn(),
    commit: vi
      .fn()
      .mockResolvedValue({ kind: 'ok' as const, updatedItems: [], pendingRestartKeys: [] }),
    inFlightKeys: new Set<string>(),
    mock: {} as never,
    updateMock: vi.fn(),
    toast: vi.fn(),
    navigateToGroup: vi.fn(),
    setFieldEditing: vi.fn(),
    ...overrides,
  };
}

describe('ProviderModelsField optimistic UI (#3 regression)', () => {
  test('commit failure releases the optimistic snapshot so UI matches env', async () => {
    // Pre-fix this scenario left the optimistic row on screen forever:
    // env never updates → useEffect-on-CSV release never fires → user
    // sees a row that doesn't actually exist server-side. Post-fix we
    // explicitly clear optimistic on commit failure so the UI reverts
    // to the genuine env state.
    const commit = vi.fn().mockResolvedValueOnce({
      kind: 'errors' as const,
      errors: [{ path: 'GOLDPAN_LLM_PROVIDER_OPENAI_MODELS', message: 'rejected' }],
    });
    const group = makeGroup({ commit }, 'gpt-4o');
    const { container } = render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ProviderModelsField group={group} providerId="openai" />
      </NextIntlClientProvider>,
    );
    const idInputs = () =>
      Array.from(container.querySelectorAll('input.gp-model-row__id')).map((el) =>
        el.getAttribute('aria-label'),
      );
    const addInput = container.querySelector(
      'input.gp-model-rows__input',
    ) as HTMLInputElement | null;
    if (!addInput) throw new Error('add input not rendered');
    fireEvent.change(addInput, { target: { value: 'rejected-model' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });
    // Optimistic snapshot shows the new row briefly.
    expect(idInputs()).toContain('rejected-model');
    // commit's promise resolved with kind=errors → setOptimistic(null)
    // → UI snaps back to env state (just 'gpt-4o').
    await vi.waitFor(() => {
      expect(idInputs()).not.toContain('rejected-model');
    });
    expect(idInputs()).toContain('gpt-4o');
  });

  test('adding a model row appears immediately in the list (before commit returns)', () => {
    // commit stays in-flight to expose the gap between user action and
    // env-state update. Pre-fix the new row was invisible until env
    // mask refreshed; post-fix the optimistic snapshot keeps it visible.
    const commit = vi.fn(
      () =>
        new Promise<CommitEnvResult>(() => {
          /* never resolves */
        }),
    );
    const group = makeGroup({ commit }, 'gpt-4o');
    const { container } = render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <ProviderModelsField group={group} providerId="openai" />
      </NextIntlClientProvider>,
    );
    // Row inputs use defaultValue + aria-label; assert via aria-label
    // queryable lookups (queryByLabelText doesn't work for label-less inputs
    // — use selector).
    const idInputs = () =>
      Array.from(container.querySelectorAll('input.gp-model-row__id')).map((el) =>
        el.getAttribute('aria-label'),
      );
    expect(idInputs()).toContain('gpt-4o');

    const addInput = container.querySelector(
      'input.gp-model-rows__input',
    ) as HTMLInputElement | null;
    expect(addInput).toBeTruthy();
    if (!addInput) return;
    fireEvent.change(addInput, { target: { value: 'gpt-4-turbo' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });
    expect(commit).toHaveBeenCalledTimes(1);
    // FIX: new row should appear immediately via optimistic state
    expect(idInputs()).toContain('gpt-4-turbo');
  });
});
