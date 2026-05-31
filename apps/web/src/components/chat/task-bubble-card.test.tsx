import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskPolling } from '@/lib/polling';
import messages from '../../../messages/zh.json';
import { TaskBubbleCard } from './task-bubble-card';

// The bubble localizes errors from `error.kind` (never the server's raw English
// `error.message`) and gates the retry button on `error.retryable`. A regression
// — leaking the English message, or re-showing retry on a non-retryable kind —
// would otherwise ship green. We mock the polling hook so each test drives a
// fixed terminal status without the real fetch loop. Server actions are mocked
// so importing the bubble doesn't pull in the `next/headers` SSR chain.
vi.mock('@/lib/polling', () => ({ useTaskPolling: vi.fn() }));
vi.mock('@/actions/retry', () => ({ retryAction: vi.fn() }));
vi.mock('@/actions/discard', () => ({ discardAction: vi.fn() }));

const mockUseTaskPolling = vi.mocked(useTaskPolling);

type PollingReturn = ReturnType<typeof useTaskPolling>;

function setup(polling: PollingReturn, defaultOpen = true) {
  mockUseTaskPolling.mockReturnValue(polling);
  return render(
    <NextIntlClientProvider locale="zh" messages={messages} timeZone="UTC">
      <TaskBubbleCard taskId={42} defaultOpen={defaultOpen} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  mockUseTaskPolling.mockReset();
});

describe('TaskBubbleCard — error localization + retry gating + tombstone', () => {
  it('(a) content_policy (non-retryable): shows localized message, hides retry', () => {
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

    // Localized — NOT the raw English message.
    expect(screen.getByText('内容政策违规')).toBeInTheDocument();
    expect(screen.queryByText('Content policy violation')).not.toBeInTheDocument();
    // Non-retryable → no retry button.
    expect(screen.queryAllByRole('button', { name: /重试/ })).toHaveLength(0);
  });

  it('(b) content_length (retryable): shows localized message + retry button', () => {
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

    // zh: "内容长度不符合要求（过短或过长）" — substring match.
    expect(screen.getByText(/内容长度不符合要求/)).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /重试/ }).length).toBeGreaterThan(0);
  });

  it('(c) notFound: renders the muted tombstone, NOT the red error bubble', () => {
    const { container } = setup(
      {
        data: null,
        error: null,
        notFound: true,
        isPolling: false,
      } as unknown as PollingReturn,
      true,
    );

    // zh: "该任务已删除。" — substring match.
    expect(screen.getByText(/该任务已删除/)).toBeInTheDocument();
    // The red error bubble must not render.
    expect(container.querySelector('.gp-task-bubble--error')).toBeNull();
    expect(screen.queryByText('内容政策违规')).not.toBeInTheDocument();
  });

  it('body is collapsed by default — error message hidden until expanded', () => {
    setup(
      {
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
      } as unknown as PollingReturn,
      false,
    );

    // Collapsed: body not rendered.
    expect(screen.queryByText('内容政策违规')).not.toBeInTheDocument();
    // Expand by clicking the head.
    fireEvent.click(screen.getByRole('button', { name: /任务/ }));
    expect(screen.getByText('内容政策违规')).toBeInTheDocument();
  });
});
