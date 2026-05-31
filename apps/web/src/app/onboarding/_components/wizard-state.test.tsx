import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWizard, WizardStateProvider } from './wizard-state';

function Inspector() {
  const { availableProviders, hydrated } = useWizard();
  return (
    <div>
      <span data-testid="hydrated">{String(hydrated)}</span>
      {availableProviders.map((p) => (
        <span key={`${p.source}-${p.id}`} data-testid="provider">
          {p.source}:{p.id}:{p.models.join(',')}
        </span>
      ))}
    </div>
  );
}

describe('WizardStateProvider availableProviders', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('hydrates availableProviders from /api/onboarding/llm-providers', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/api/onboarding/state')) {
        return new Response(JSON.stringify({ providers: {}, steps: {} }), { status: 200 });
      }
      if (String(url).endsWith('/api/onboarding/llm-providers')) {
        return new Response(
          JSON.stringify({
            builtin: [{ id: 'openai' }],
            custom: [{ id: 'together', models: ['llama-3.3-70b'] }],
            plugin: [{ providerId: 'cohere', models: ['command-r-plus'] }],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    }) as never;

    render(
      <WizardStateProvider>
        <Inspector />
      </WizardStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('provider').map((e) => e.textContent)).toEqual(
        expect.arrayContaining([
          'builtin:openai:',
          'custom:together:llama-3.3-70b',
          'plugin:cohere:command-r-plus',
        ]),
      );
    });
  });

  it('falls back to empty array on fetch failure', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/api/onboarding/state')) {
        return new Response(JSON.stringify({ providers: {}, steps: {} }), { status: 200 });
      }
      return new Response('', { status: 500 });
    }) as never;

    render(
      <WizardStateProvider>
        <Inspector />
      </WizardStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('hydrated').textContent).toBe('true');
    });
    expect(screen.queryAllByTestId('provider')).toEqual([]);
  });
});
