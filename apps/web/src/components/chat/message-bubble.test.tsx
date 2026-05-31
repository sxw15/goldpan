import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import zhMessages from '../../../messages/zh.json';
import type { ChatMessage } from './chat-view';
import { MessageBubble } from './message-bubble';

// 与 buffered-wait-indicator.test.tsx:11 同模式 — useTranslations 必须包在
// NextIntlClientProvider 里，喂全量 zh.json 避免遗漏命名空间。
function renderWithIntl(node: ReactElement) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zhMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe('MessageBubble — buffered_wait', () => {
  it('user message with status=buffered_wait → 渲染 BufferedWaitIndicator', () => {
    const onRelease = vi.fn();
    const onCancel = vi.fn();
    const message: ChatMessage = {
      id: 'db-42',
      // P3 二轮 review：BufferedWaitIndicator 用 numeric id 调 release/cancel API
      dbMessageId: 42,
      role: 'user',
      content: '明天那个...',
      timestamp: Date.now(),
      status: 'buffered_wait',
      bufferedExpiresAt: Date.now() + 30000,
      metadata: { waitReasonKey: 'incomplete_command' },
    };
    renderWithIntl(
      <MessageBubble
        message={message}
        onEntitySelect={vi.fn()}
        onReleaseBuffered={onRelease}
        onCancelBuffered={onCancel}
      />,
    );
    // BufferedWaitIndicator 根 div 有 role="status"
    expect(screen.getByRole('status')).toBeInTheDocument();
    // "立即执行" 按钮 — intent_classifier.execute_now_button
    expect(screen.getByRole('button', { name: '立即执行' })).toBeInTheDocument();
    // waitReason 文案 — intent_classifier.wait_reason.incomplete_command
    expect(screen.getByText('句子未完成')).toBeInTheDocument();
  });

  it('user message with status=normal → 不渲染 indicator', () => {
    const message: ChatMessage = {
      id: 'db-43',
      dbMessageId: 43,
      role: 'user',
      content: 'normal',
      timestamp: Date.now(),
      status: 'normal',
    };
    renderWithIntl(<MessageBubble message={message} onEntitySelect={vi.fn()} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
