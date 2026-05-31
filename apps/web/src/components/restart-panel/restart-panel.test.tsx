import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { pollForReady, probeServerLive } from './poller';
import { clearRestartFlag, readRestartFlag } from './restart-flag';
import { RestartPanel } from './restart-panel';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('./perform-restart', () => ({
  performRestart: vi.fn(),
}));

vi.mock('./poller', () => ({
  pollForReady: vi.fn(),
  probeServerLive: vi.fn(),
}));

vi.mock('./restart-flag', () => ({
  clearRestartFlag: vi.fn(),
  readRestartFlag: vi.fn(),
}));

const originalLocation = window.location;

function setLocation(pathname: string, search = '', hash = '') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      assign: vi.fn(),
      hash,
      origin: 'http://localhost',
      pathname,
      reload: vi.fn(),
      search,
    },
    writable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readRestartFlag).mockReturnValue(true);
  vi.mocked(probeServerLive).mockResolvedValue(true);
  vi.mocked(pollForReady).mockResolvedValue('ready');
  setLocation('/settings');
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
    writable: true,
  });
});

describe('<RestartPanel>', () => {
  test('resume effect navigates when only redirect query differs', async () => {
    render(
      <RestartPanel
        supervisor="docker"
        tNamespace="settings.about.restart"
        redirectTo="/settings?group=about"
      />,
    );

    await waitFor(() => {
      expect(clearRestartFlag).toHaveBeenCalledOnce();
    });
    expect(window.location.assign).toHaveBeenCalledWith('/settings?group=about');
  });

  test('resume effect stays put when pathname, query, and hash already match redirect', async () => {
    setLocation('/settings', '?group=about');

    render(
      <RestartPanel
        supervisor="docker"
        tNamespace="settings.about.restart"
        redirectTo="/settings?group=about"
      />,
    );

    await waitFor(() => {
      expect(clearRestartFlag).toHaveBeenCalledOnce();
    });
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});
