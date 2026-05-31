import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { TzProvider } from '@/components/tz-provider';
import messages from '../../../messages/zh.json';
import { ErrorView, type ErrorViewProps } from './error-view';

// Covers the user-facing retry-gating + per-kind advice — the half of the
// retry/error change that was previously only browser-verified. A regression
// here (re-showing retry on content_policy, hiding it on retryable kinds, or the
// content_length advice contradiction) would otherwise ship green.
function setup(overrides: Partial<ErrorViewProps>) {
  const props: ErrorViewProps = {
    taskId: 42,
    sourceUrl: null,
    createdAt: null,
    sourceTitle: null,
    sourceKindLabel: '',
    failedStep: null,
    errorMessage: '测试错误',
    errorKind: 'unknown',
    retryable: true,
    technicalLog: null,
    isRetrying: false,
    isDeleting: false,
    showDelete: false,
    onRetry: vi.fn(),
    onDelete: vi.fn(),
    toast: vi.fn(),
    mobile: false,
    ...overrides,
  };
  return render(
    <NextIntlClientProvider locale="zh" messages={messages} timeZone="UTC">
      <TzProvider tz="UTC">
        <ErrorView {...props} />
      </TzProvider>
    </NextIntlClientProvider>,
  );
}

describe('ErrorView retry-gating + advice', () => {
  it('content_policy (non-retryable): hides retry, shows policy advice, no "just retry" line', () => {
    setup({ errorKind: 'content_policy', retryable: false });
    expect(screen.queryAllByRole('button', { name: /重试/ })).toHaveLength(0);
    expect(screen.getByText(/内容触发了内容策略限制/)).toBeInTheDocument();
    expect(screen.queryByText(/直接重试/)).not.toBeInTheDocument();
    // sanity: the card still rendered (copy-error fallback action present)
    expect(screen.getByText('复制错误信息')).toBeInTheDocument();
  });

  it('content_length (retryable): shows retry + length advice, NOT the plain-text-excerpt line', () => {
    setup({ errorKind: 'content_length', retryable: true });
    expect(screen.queryAllByRole('button', { name: /重试/ }).length).toBeGreaterThan(0);
    expect(screen.getByText(/内容长度超出允许范围/)).toBeInTheDocument();
    // card_hint_text was dropped from the content_length branch (contradictory).
    expect(screen.queryByText(/纯文本片段/)).not.toBeInTheDocument();
  });

  it('generic retryable kind: shows retry + the standard retry/plain-text advice', () => {
    setup({ errorKind: 'timeout', retryable: true });
    expect(screen.queryAllByRole('button', { name: /重试/ }).length).toBeGreaterThan(0);
    expect(screen.getByText(/直接重试/)).toBeInTheDocument();
    expect(screen.getByText(/纯文本片段/)).toBeInTheDocument();
  });
});
