import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Cache translate functions per namespace so useTranslations returns a stable
// reference across renders (matches real next-intl behavior; without this the
// component's useCallback deps churn and re-fire the poll every render).
const translateCache = new Map<
  string | undefined,
  (key: string, params?: Record<string, unknown>) => string
>();
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => {
    let cached = translateCache.get(ns);
    if (!cached) {
      cached = (key: string, params?: Record<string, unknown>) => {
        if (!params) return `${ns}.${key}`;
        return `${ns}.${key}(${Object.entries(params)
          .map(([k, v]) => `${k}=${v}`)
          .join(',')})`;
      };
      translateCache.set(ns, cached);
    }
    return cached;
  },
}));

const mockListNotes = vi.fn();
const mockMarkReminded = vi.fn();
vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    listNotes: mockListNotes,
    markNoteReminded: mockMarkReminded,
  }),
}));

import { DueRemindersBanner } from './due-reminders-banner';

const originalNotification = window.Notification;

function noteFixture(id: number, content: string, dueAt = 100) {
  return {
    id,
    content,
    subtype: 'memo' as const,
    dueAt,
    remindedAt: null,
    pinned: false,
    archived: false,
    contentTranslated: null,
    language: null,
    sourceMessageId: null,
    conversationId: null,
    tags: [],
    linkedEntities: [],
    linkedSources: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('<DueRemindersBanner>', () => {
  beforeEach(() => {
    mockListNotes.mockReset();
    mockMarkReminded.mockReset();
    mockListNotes.mockResolvedValue({ data: [], total: 0 });
    mockMarkReminded.mockResolvedValue({ remindedAt: Date.now() });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalNotification === undefined) {
      Reflect.deleteProperty(window, 'Notification');
    } else {
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: originalNotification,
      });
    }
  });

  it('renders nothing when poll returns empty', async () => {
    vi.useFakeTimers();
    const { container } = render(<DueRemindersBanner />);
    await vi.runOnlyPendingTimersAsync();
    expect(container.querySelector('.gp-due-banner')).toBeNull();
  });

  it('renders banner items when poll returns due notes', async () => {
    mockListNotes.mockResolvedValueOnce({
      data: [noteFixture(1, 'pay rent today')],
      total: 1,
    });
    render(<DueRemindersBanner />);
    expect(await screen.findByText(/pay rent today/u)).toBeInTheDocument();
  });

  it('clicking mark-reminded button removes that note from banner', async () => {
    mockListNotes.mockResolvedValueOnce({
      data: [noteFixture(7, 'remind me', 100)],
      total: 1,
    });
    render(<DueRemindersBanner />);
    const btn = await screen.findByRole('button', { name: /mark_reminded/u });
    fireEvent.click(btn);
    await waitFor(() => expect(mockMarkReminded).toHaveBeenCalledWith(7, { expectedDueAt: 100 }));
    expect(screen.queryByText('remind me')).not.toBeInTheDocument();
  });

  it('does not restore a dismissed reminder if a later poll returns the same dueAt', async () => {
    vi.useFakeTimers();
    mockListNotes
      .mockResolvedValueOnce({ data: [noteFixture(7, 'dismiss me', 100)], total: 1 })
      .mockResolvedValueOnce({ data: [noteFixture(7, 'dismiss me', 100)], total: 1 });
    render(<DueRemindersBanner />);
    await flushAsyncWork();
    const btn = screen.getByRole('button', { name: /mark_reminded/u });
    fireEvent.click(btn);
    await flushAsyncWork();
    expect(mockMarkReminded).toHaveBeenCalledWith(7, { expectedDueAt: 100 });
    expect(screen.queryByText('dismiss me')).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await flushAsyncWork();
    expect(screen.queryByText('dismiss me')).not.toBeInTheDocument();
  });

  it('sends a new desktop notification when the same note gets a new dueAt', async () => {
    vi.useFakeTimers();
    const notification = vi.fn();
    Object.defineProperty(notification, 'permission', { configurable: true, value: 'granted' });
    Object.defineProperty(window, 'Notification', { configurable: true, value: notification });
    mockListNotes
      .mockResolvedValueOnce({ data: [noteFixture(7, 'notify me', 100)], total: 1 })
      .mockResolvedValueOnce({ data: [noteFixture(7, 'notify me again', 200)], total: 1 });

    render(<DueRemindersBanner />);
    await flushAsyncWork();
    expect(notification).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await flushAsyncWork();
    expect(notification).toHaveBeenCalledTimes(2);
  });
});
