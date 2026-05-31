import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import enMessages from '../../../../messages/en.json';
import { WizardStateProvider } from '../_components/wizard-state';
import { AuthForm } from './_form';

const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockReplace }),
  usePathname: () => '/onboarding/auth',
}));

function renderAuthForm({ isProduction = false } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WizardStateProvider>
        <AuthForm isProduction={isProduction} />
      </WizardStateProvider>
    </NextIntlClientProvider>,
  );
}

function makeFetchMock(commitResponse: { ok: boolean; status: number; body: unknown }) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/api/onboarding/state')) {
      return new Response(JSON.stringify({ providers: {}, steps: {} }), { status: 200 });
    }
    if (u.endsWith('/api/onboarding/llm-providers')) {
      return new Response(JSON.stringify({ builtin: [], custom: [], plugin: [] }), { status: 200 });
    }
    if (u.endsWith('/api/onboarding/commit')) {
      return new Response(JSON.stringify(commitResponse.body), { status: commitResponse.status });
    }
    return new Response('{}', { status: 404 });
  }) as never;
}

describe('<AuthForm> commit flow', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockReplace.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('renders validation errors returned by the server', async () => {
    global.fetch = makeFetchMock({
      ok: false,
      status: 400,
      body: {
        kind: 'errors',
        ok: false,
        errors: [{ path: '', message: 'Missing API key' }],
      },
    });

    renderAuthForm();
    // Wait for hydration so the submit button is present.
    const button = await screen.findByRole('button', { name: 'Submit configuration' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText('Configuration validation failed:')).toBeInTheDocument();
      expect(screen.getByText(/Missing API key/)).toBeInTheDocument();
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('redirects to /onboarding/complete on successful commit', async () => {
    global.fetch = makeFetchMock({
      ok: true,
      status: 200,
      body: { kind: 'ok', ok: true },
    });

    renderAuthForm();
    const button = await screen.findByRole('button', { name: 'Submit configuration' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/onboarding/complete');
    });
  });

  test('passes ?seed_failed=1 when commit reports metadataSeedFailed', async () => {
    global.fetch = makeFetchMock({
      ok: true,
      status: 200,
      body: { kind: 'ok', ok: true, metadataSeedFailed: true },
    });

    renderAuthForm();
    const button = await screen.findByRole('button', { name: 'Submit configuration' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/onboarding/complete?seed_failed=1');
    });
  });
});
