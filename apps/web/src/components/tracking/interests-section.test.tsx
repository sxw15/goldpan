import type { InterestListItem } from '@goldpan/web-sdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/zh.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

import { InterestsSection } from './interests-section';

function renderWithIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="zh" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
}

function fixture(overrides: Partial<InterestListItem> = {}): InterestListItem {
  return {
    id: 1,
    name: 'X',
    description: null,
    searchQueries: ['x'],
    toolProvider: null,
    intervalMinutes: 60,
    enabled: true,
    status: 'idle',
    lastRunAt: null,
    nextRunAt: null,
    linkedEntityIds: [],
    linkedEntityCount: 0,
    totalHits: 0,
    newHits24h: 0,
    ingestedTotal: 0,
    sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('<InterestsSection>', () => {
  it('renders empty state', () => {
    renderWithIntl(
      <InterestsSection
        result={{ ok: [] }}
        showNewForm={false}
        onToggleNewForm={vi.fn()}
        onSubmitNew={vi.fn()}
        onOpenInterest={vi.fn()}
      />,
    );
    expect(screen.getByText(/还没有追踪项/)).toBeInTheDocument();
  });

  it('renders list of interests', () => {
    const interests = [
      fixture({ id: 1, name: 'AI', searchQueries: ['a', 'b'], intervalMinutes: 30 }),
    ];
    renderWithIntl(
      <InterestsSection
        result={{ ok: interests }}
        showNewForm={false}
        onToggleNewForm={vi.fn()}
        onSubmitNew={vi.fn()}
        onOpenInterest={vi.fn()}
      />,
    );
    expect(screen.getByText('AI')).toBeInTheDocument();
  });

  it('click "新建追踪项" calls onToggleNewForm', async () => {
    const onToggleNewForm = vi.fn();
    renderWithIntl(
      <InterestsSection
        result={{ ok: [] }}
        showNewForm={false}
        onToggleNewForm={onToggleNewForm}
        onSubmitNew={vi.fn()}
        onOpenInterest={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /新建追踪项/ }));
    expect(onToggleNewForm).toHaveBeenCalled();
  });

  it('hides new-interest entry points when search tool setup is missing', () => {
    const interests = [fixture({ id: 1, name: 'AI' })];
    renderWithIntl(
      <InterestsSection
        result={{ ok: interests }}
        showNewForm={true}
        onToggleNewForm={vi.fn()}
        onSubmitNew={vi.fn()}
        onOpenInterest={vi.fn()}
        searchToolWarning
      />,
    );
    expect(screen.queryByRole('button', { name: /新建追踪项/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /创建/ })).not.toBeInTheDocument();
  });

  it('showNewForm=true renders InterestForm (submit label = 创建)', () => {
    renderWithIntl(
      <InterestsSection
        result={{ ok: [] }}
        showNewForm={true}
        onToggleNewForm={vi.fn()}
        onSubmitNew={vi.fn()}
        onOpenInterest={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /创建/ })).toBeInTheDocument();
  });

  it('item click opens interest', async () => {
    const onOpenInterest = vi.fn();
    const interests = [fixture({ id: 42, name: 'X' })];
    renderWithIntl(
      <InterestsSection
        result={{ ok: interests }}
        showNewForm={false}
        onToggleNewForm={vi.fn()}
        onSubmitNew={vi.fn()}
        onOpenInterest={onOpenInterest}
      />,
    );
    await userEvent.click(screen.getByText('X'));
    expect(onOpenInterest).toHaveBeenCalledWith(42);
  });

  it('disabled item has --disabled modifier class', () => {
    const interests = [fixture({ enabled: false })];
    const { container } = renderWithIntl(
      <InterestsSection
        result={{ ok: interests }}
        showNewForm={false}
        onToggleNewForm={vi.fn()}
        onSubmitNew={vi.fn()}
        onOpenInterest={vi.fn()}
      />,
    );
    expect(container.querySelector('.gp-interests-section__item--disabled')).not.toBeNull();
  });

  it('renders last/next run timestamps when present', () => {
    const interests = [
      fixture({
        id: 5,
        name: 'R',
        lastRunAt: Date.parse('2026-04-01T10:00:00.000Z'),
        nextRunAt: Date.parse('2026-04-02T10:00:00.000Z'),
      }),
    ];
    renderWithIntl(
      <InterestsSection
        result={{ ok: interests }}
        showNewForm={false}
        onToggleNewForm={vi.fn()}
        onSubmitNew={vi.fn()}
        onOpenInterest={vi.fn()}
      />,
    );
    expect(screen.getByText(/2026-04-01/)).toBeInTheDocument();
    expect(screen.getByText(/2026-04-02/)).toBeInTheDocument();
  });

  it('error state renders retry', () => {
    renderWithIntl(
      <InterestsSection
        result={{ error: 'boom' }}
        showNewForm={false}
        onToggleNewForm={vi.fn()}
        onSubmitNew={vi.fn()}
        onOpenInterest={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
