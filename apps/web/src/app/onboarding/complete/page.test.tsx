import { render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import enMessages from '../../../../messages/en.json';
import CompletePage from './page';

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

let mockSearchParams = new URLSearchParams();

function mockRuntimeInfo(supervisor: 'docker' | 'supervised' | 'concurrently' | 'unknown') {
  global.fetch = vi.fn(
    async () => new Response(JSON.stringify({ supervisor }), { status: 200 }),
  ) as never;
}

function renderCompletePage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CompletePage />
    </NextIntlClientProvider>,
  );
}

describe('<CompletePage>', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockRuntimeInfo('unknown');
    mockSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('renders the success heading, saved-status pill, and demo links', async () => {
    renderCompletePage();
    expect(screen.getByText('Configuration complete')).toBeInTheDocument();
    expect(screen.getByText('Configuration saved')).toBeInTheDocument();
    expect(screen.getByText('YouTube demo')).toBeInTheDocument();
    expect(screen.getByText('Bilibili demo')).toBeInTheDocument();
    // No metadata-seed warning when ?seed_failed is absent.
    expect(screen.queryByText(/presets not seeded/)).not.toBeInTheDocument();
    // Wait for runtime-info probe so test doesn't leak unhandled promises.
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  test('surfaces the seed-failed warning when ?seed_failed=1 is set', () => {
    mockSearchParams = new URLSearchParams('?seed_failed=1');
    renderCompletePage();
    expect(screen.getByText(/presets not seeded/i)).toBeInTheDocument();
  });

  test('renders the auto-restart panel for supervisor=docker', async () => {
    mockRuntimeInfo('docker');
    renderCompletePage();
    // Heading + button reflect the auto-restart flow.
    await waitFor(() => {
      expect(screen.getByText('Restart into normal mode')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeInTheDocument();
    // Manual instructions must NOT appear in this branch.
    expect(screen.queryByText(/Press Ctrl\+C/)).not.toBeInTheDocument();
  });

  test('renders the unknown-supervisor hint alongside the auto-restart panel', async () => {
    mockRuntimeInfo('unknown');
    renderCompletePage();
    await waitFor(() => {
      expect(screen.getByText('Restart into normal mode')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Supervisor not recognized — if the page doesn't recover/),
    ).toBeInTheDocument();
  });

  test('renders the manual-instruction panel for supervisor=concurrently', async () => {
    mockRuntimeInfo('concurrently');
    renderCompletePage();
    await waitFor(() => {
      expect(screen.getByText('Restart from your terminal')).toBeInTheDocument();
    });
    // Numbered steps + the exact rerun command must be visible.
    expect(screen.getByText(/Press Ctrl\+C/)).toBeInTheDocument();
    expect(screen.getByText('pnpm dev')).toBeInTheDocument();
    // No destructive auto-restart button in concurrently mode.
    expect(screen.queryByRole('button', { name: 'Restart now' })).not.toBeInTheDocument();
  });
});
