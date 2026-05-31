import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import zhMessages from '../../../messages/zh.json';
import { BufferedWaitIndicator } from './buffered-wait-indicator';

// 与 chat-view.test.tsx:32 同模式 — useTranslations 必须在 NextIntlClientProvider 内。
// `next-intl` 默认会要求 messages 覆盖所有命名空间用例；这里直接喂全量 zh.json
// 跟集成测试保持一致，避免遗漏。
function renderWithIntl(node: ReactElement) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zhMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe('BufferedWaitIndicator', () => {
  it('显示倒计时秒数 + waitReason 文案', () => {
    renderWithIntl(
      <BufferedWaitIndicator
        messageId={42}
        expiresAt={Date.now() + 30000}
        waitReasonKey="incomplete_command"
        onRelease={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // zh.json intent_classifier.wait_reason.incomplete_command = "句子未完成"
    expect(screen.getByText('句子未完成')).toBeInTheDocument();
    // 倒计时秒数（取 expiresAt - now 的秒数，可能 29 或 30 看 setup 时序）
    expect(screen.getByText(/^(29|30)s$/)).toBeInTheDocument();
  });

  it('点 "立即执行" 调 onRelease(messageId)', () => {
    const onRelease = vi.fn();
    renderWithIntl(
      <BufferedWaitIndicator
        messageId={42}
        expiresAt={Date.now() + 30000}
        waitReasonKey="incomplete_command"
        onRelease={onRelease}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '立即执行' }));
    expect(onRelease).toHaveBeenCalledWith(42);
  });

  it('点 "取消" 调 onCancel(messageId)', () => {
    const onCancel = vi.fn();
    renderWithIntl(
      <BufferedWaitIndicator
        messageId={42}
        expiresAt={Date.now() + 30000}
        waitReasonKey="incomplete_command"
        onRelease={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledWith(42);
  });

  it('倒计时归零 maxWaitMs-500ms 前自动调 onRelease', async () => {
    vi.useFakeTimers();
    try {
      const onRelease = vi.fn();
      renderWithIntl(
        <BufferedWaitIndicator
          messageId={42}
          expiresAt={Date.now() + 1000}
          waitReasonKey="incomplete_command"
          onRelease={onRelease}
          onCancel={vi.fn()}
        />,
      );

      // 推进到 500ms 之前不该触发（setTimeout 在 1000-500=500ms 处触发）
      await vi.advanceTimersByTimeAsync(400);
      expect(onRelease).not.toHaveBeenCalled();

      // 再推进到 500ms 处（剩 500ms 时触发）
      await vi.advanceTimersByTimeAsync(200);
      expect(onRelease).toHaveBeenCalledWith(42);
    } finally {
      vi.useRealTimers();
    }
  });
});
