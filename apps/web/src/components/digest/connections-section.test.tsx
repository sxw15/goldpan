import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import enMessages from '../../../messages/en.json';
import { ConnectionsSection } from './connections-section';

const mockGetConnections = vi.fn();
vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({ getDigestConnections: mockGetConnections }),
}));

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  mockGetConnections.mockReset();
});

describe('ConnectionsSection', () => {
  it('renders nothing during loading', () => {
    mockGetConnections.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = wrap(<ConnectionsSection sinceMs={0} onOpenEntity={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('hides section when length < 3', async () => {
    mockGetConnections.mockResolvedValue({
      data: [
        {
          id: 1,
          createdAt: 0,
          relationType: 'general',
          source: { id: 1, name: 'A', categoryPaths: [] },
          target: { id: 2, name: 'B', categoryPaths: [] },
        },
      ],
      total: 1,
    });
    const { container } = wrap(<ConnectionsSection sinceMs={0} onOpenEntity={() => {}} />);
    await waitFor(() => expect(mockGetConnections).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders list when length >= 3 and clicking entity calls onOpenEntity', async () => {
    mockGetConnections.mockResolvedValue({
      data: [1, 2, 3].map((i) => ({
        id: i,
        createdAt: 0,
        relationType: 'general' as const,
        source: { id: i * 10, name: `S${i}`, categoryPaths: [] },
        target: { id: i * 10 + 1, name: `T${i}`, categoryPaths: [] },
      })),
      total: 3,
    });
    const onOpenEntity = vi.fn();
    wrap(<ConnectionsSection sinceMs={0} onOpenEntity={onOpenEntity} />);
    await waitFor(() => expect(screen.getByText('S1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('S1'));
    expect(onOpenEntity).toHaveBeenCalledWith(10);
    fireEvent.click(screen.getByText('T2'));
    expect(onOpenEntity).toHaveBeenCalledWith(21);
  });

  it('shows error placeholder on fetch error and warns', async () => {
    // 改自旧 "hides on fetch error":整段隐藏让 operator 看不到失败,改为显示
    // i18n placeholder + role="status" 让 a11y 也能播报。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetConnections.mockRejectedValue(new Error('boom'));
    const { container } = wrap(<ConnectionsSection sinceMs={0} onOpenEntity={() => {}} />);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    const placeholder = container.querySelector('.gp-digest-section__error');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute('role')).toBe('status');
    expect(placeholder?.textContent).toBe('Connections temporarily unavailable.');
    warn.mockRestore();
  });
});
