import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import zhMessages from '../../../messages/zh.json';
import { ClarifyChip } from './clarify-chip';

// 与 buffered-wait-indicator.test.tsx:11 同模式 — useTranslations 必须包在
// NextIntlClientProvider 里，喂全量 zh.json 避免遗漏命名空间。
function renderWithIntl(node: ReactElement) {
  return render(
    <NextIntlClientProvider locale="zh" messages={zhMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe('ClarifyChip', () => {
  it('用 intent_classifier.clarify_option.<intentKey> 渲染翻译标签', () => {
    renderWithIntl(<ClarifyChip intentKey="create_note" onClick={vi.fn()} />);
    // zh.json intent_classifier.clarify_option.create_note = "记笔记"
    expect(screen.getByRole('button')).toHaveTextContent('记笔记');
  });

  it('click → onClick(intentKey, payload)', () => {
    const onClick = vi.fn();
    renderWithIntl(<ClarifyChip intentKey="query" payload="some payload" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledWith('query', 'some payload');
  });

  it('disabled 时 click 不调 onClick', () => {
    const onClick = vi.fn();
    renderWithIntl(<ClarifyChip intentKey="query" onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('resolve_tracking_entity 用 payload.entityName 覆盖 i18n label', () => {
    renderWithIntl(
      <ClarifyChip
        intentKey="resolve_tracking_entity"
        payload={JSON.stringify({ trackingRuleId: 7, entityId: 42, entityName: 'Anthropic' })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Anthropic');
  });
});
