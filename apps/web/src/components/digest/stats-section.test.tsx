import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import enMessages from '../../../messages/en.json';
import { StatsSection } from './stats-section';

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('StatsSection', () => {
  it('renders 4 labeled numeric stats from props', () => {
    wrap(<StatsSection captures={3} findings={5} thoughts={2} entities={7} period="weekly" />);
    expect(screen.getByText('Captures')).toBeInTheDocument();
    expect(screen.getByText('Findings')).toBeInTheDocument();
    expect(screen.getByText('Thoughts')).toBeInTheDocument();
    expect(screen.getByText('Entities')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('renders zeros instead of hiding (skipEmpty handled by parent)', () => {
    // StatsSection 不自己判 0:渲染政策(stats 全 0 时是否隐藏)由 DigestSections
    // 的 skipEmpty 决定。否则 0 vs 缺失数据无法区分。
    const { container } = wrap(
      <StatsSection captures={0} findings={0} thoughts={0} entities={0} period="weekly" />,
    );
    const values = container.querySelectorAll('.gp-digest-stats__value');
    expect(values).toHaveLength(4);
    for (const v of values) expect(v.textContent).toBe('0');
  });
});
