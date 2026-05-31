import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskPolling } from '@/lib/polling';
import messages from '../../../messages/zh.json';
import { NoteBubbleCard } from './note-bubble-card';

// Same contract as TaskBubbleCard but the note bubble has no collapse — the
// error body renders directly. Localizes from `error.kind`, gates retry on
// `error.retryable`, and shows a muted tombstone (not the red error bubble) on
// 404/notFound. Polling + the retry server action are mocked so each test drives
// a fixed terminal status without the fetch loop or the SSR import chain.
vi.mock('@/lib/polling', () => ({ useTaskPolling: vi.fn() }));
vi.mock('@/actions/retry', () => ({ retryAction: vi.fn() }));

const mockUseTaskPolling = vi.mocked(useTaskPolling);

type PollingReturn = ReturnType<typeof useTaskPolling>;

function setup(polling: PollingReturn) {
  mockUseTaskPolling.mockReturnValue(polling);
  return render(
    <NextIntlClientProvider locale="zh" messages={messages} timeZone="UTC">
      <NoteBubbleCard taskId={42} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  mockUseTaskPolling.mockReset();
});

describe('NoteBubbleCard — error localization + retry gating + tombstone', () => {
  it('content_policy (non-retryable): shows localized message, hides retry', () => {
    setup({
      data: {
        status: 'error',
        taskId: '42',
        sourceId: 1,
        createdAt: Date.now(),
        error: {
          step: 'verifying',
          kind: 'content_policy',
          message: 'Content policy violation',
          retryable: false,
        },
        sourceUrl: null,
      },
      error: null,
      notFound: false,
      isPolling: false,
    } as unknown as PollingReturn);

    expect(screen.getByText('内容政策违规')).toBeInTheDocument();
    expect(screen.queryByText('Content policy violation')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /重试/ })).toHaveLength(0);
  });

  it('content_length (retryable): shows localized message + retry button', () => {
    setup({
      data: {
        status: 'error',
        taskId: '42',
        sourceId: 1,
        createdAt: Date.now(),
        error: {
          step: 'collecting',
          kind: 'content_length',
          message: 'Content too short',
          retryable: true,
        },
        sourceUrl: null,
      },
      error: null,
      notFound: false,
      isPolling: false,
    } as unknown as PollingReturn);

    expect(screen.getByText(/内容长度不符合要求/)).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /重试/ }).length).toBeGreaterThan(0);
  });

  it('notFound: renders the muted tombstone, NOT the red error bubble', () => {
    const { container } = setup({
      data: null,
      error: null,
      notFound: true,
      isPolling: false,
    } as unknown as PollingReturn);

    expect(screen.getByText(/该任务已删除/)).toBeInTheDocument();
    expect(container.querySelector('.gp-note-bubble--error')).toBeNull();
    expect(screen.queryByText('内容政策违规')).not.toBeInTheDocument();
  });
});
