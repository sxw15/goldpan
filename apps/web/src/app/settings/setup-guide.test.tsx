import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import zh from '../../../messages/zh.json';
import { SetupGuide } from './setup-guide';

const guide = {
  allDoneTitle: 'All set',
  steps: [
    {
      id: 'step1',
      title: 'Create the token',
      desc: 'Visit github.com/settings/tokens.',
      externalLink: { label: 'Open GitHub', href: 'https://github.com/settings/tokens' },
    },
    {
      id: 'step2',
      title: 'Paste it here',
      desc: 'Copy the token and paste below.',
      images: ['01-token.png'],
    },
  ],
};

// useTranslations('plugin_card') needs an Intl provider; we wrap with the same
// zh fixture used by neighbour tests so the only difference between snapshots
// is the component under test.
function renderWithI18n(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('SetupGuide', () => {
  it('renders collapsed by default — <details> has no open attribute', () => {
    // jsdom renders <details> children regardless of open state (no visual
    // hiding), so we verify collapse via the attribute rather than visibility.
    const { container } = renderWithI18n(<SetupGuide pluginId="collector-github" guide={guide} />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('renders steps when summary clicked', () => {
    const { container } = renderWithI18n(<SetupGuide pluginId="collector-github" guide={guide} />);
    const details = container.querySelector('details');
    if (!details) throw new Error('expected <details> element');
    details.setAttribute('open', '');
    expect(screen.getByText('Create the token')).toBeInTheDocument();
    expect(screen.getByText('Paste it here')).toBeInTheDocument();
  });

  it('image src points at the plugin asset route', async () => {
    const { container } = renderWithI18n(<SetupGuide pluginId="collector-github" guide={guide} />);
    container.querySelector('details')?.setAttribute('open', '');
    const img = await screen.findByRole('img');
    expect(img.getAttribute('src')).toBe(
      '/api/settings/contributions/collector-github/assets/01-token.png',
    );
  });

  it('preserves `/` in nested image paths so server routing finds the file', async () => {
    // assetUrl previously encoded the whole path via encodeURIComponent,
    // turning `steps/01.png` into `steps%2F01.png`; the server splits on `/`
    // before resolving the file, so the literal `%2F` filename never matches.
    const nestedGuide = {
      ...guide,
      steps: [{ id: 'nested', title: 'Nested', desc: '', images: ['steps/01.png'] }],
    };
    const { container } = renderWithI18n(
      <SetupGuide pluginId="collector-github" guide={nestedGuide} />,
    );
    container.querySelector('details')?.setAttribute('open', '');
    const img = await screen.findByRole('img');
    expect(img.getAttribute('src')).toBe(
      '/api/settings/contributions/collector-github/assets/steps/01.png',
    );
  });

  it('still percent-encodes characters within each segment', async () => {
    // Spaces inside a segment still need encoding even when we preserve `/`.
    const escapedGuide = {
      ...guide,
      steps: [{ id: 'escaped', title: 'Escaped', desc: '', images: ['a b/c d.png'] }],
    };
    const { container } = renderWithI18n(
      <SetupGuide pluginId="collector-github" guide={escapedGuide} />,
    );
    container.querySelector('details')?.setAttribute('open', '');
    const img = await screen.findByRole('img');
    expect(img.getAttribute('src')).toBe(
      '/api/settings/contributions/collector-github/assets/a%20b/c%20d.png',
    );
  });

  it('renders external link with target=_blank rel=noreferrer', async () => {
    const { container } = renderWithI18n(<SetupGuide pluginId="collector-github" guide={guide} />);
    container.querySelector('details')?.setAttribute('open', '');
    const link = await screen.findByRole('link', { name: 'Open GitHub' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
  });
});
