import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next-intl: 返回 key + 参数，便于断言。和 note-payload / source-payload 测试一致。
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, params?: Record<string, unknown>) => {
    if (params) {
      const formatted = Object.entries(params)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',');
      return `${ns}.${key}(${formatted})`;
    }
    return `${ns}.${key}`;
  },
}));

const mockGetInterest = vi.fn();

vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    getInterest: mockGetInterest,
  }),
}));

// mock InterestForm（T9 实装；T7 测试先 mock）
// testid 按钮模拟 form 内部 dirty diff 上报，覆盖 onDirtyChange 契约。
vi.mock('../../tracking/interest-form', () => ({
  InterestForm: ({
    onSubmit,
    onCancel,
    onDirtyChange,
  }: {
    onSubmit: (patch: unknown) => Promise<void>;
    onCancel: () => void;
    onDirtyChange?: (dirty: boolean) => void;
  }) => (
    <div data-testid="mock-form">
      <button type="button" onClick={() => onSubmit({ name: 'renamed' })}>
        submit
      </button>
      <button type="button" onClick={onCancel}>
        cancel
      </button>
      <button type="button" data-testid="form-dirty-true" onClick={() => onDirtyChange?.(true)}>
        dirty-true
      </button>
      <button type="button" data-testid="form-dirty-false" onClick={() => onDirtyChange?.(false)}>
        dirty-false
      </button>
      <button type="button" data-testid="form-cancel" onClick={onCancel}>
        form-cancel
      </button>
    </div>
  ),
}));

import { InterestPayload } from './interest-payload';
import type { PayloadAction, PayloadCapabilitySet } from './types';

// Capability set matching TrackingShell: all three interest actions declared
// so edit / delete / enable toggle UI renders under test.
const INTEREST_CAPS: PayloadCapabilitySet = new Set<PayloadAction['type']>([
  'updateInterest',
  'deleteInterest',
  'setInterestEnabled',
]);

const baseDetail = {
  interest: {
    id: 1,
    name: 'AI News',
    description: 'Daily AI updates',
    searchQueries: ['AI', 'LLM'],
    toolProvider: null,
    intervalMinutes: 60,
    enabled: true,
    status: 'idle' as const,
    lastRunAt: null,
    nextRunAt: null,
    linkedEntityIds: [10],
    createdAt: Date.parse('2026-04-01T00:00:00.000Z'),
    updatedAt: Date.parse('2026-04-01T00:00:00.000Z'),
  },
  linkedEntities: [{ id: 10, name: 'E10', categoryPaths: [] }],
  recentExecutions: [
    {
      id: 1,
      status: 'done' as const,
      itemsFound: 5,
      itemsSubmitted: 2,
      startedAt: Date.parse('2026-04-10T00:00:00.000Z'),
      finishedAt: Date.parse('2026-04-10T00:05:00.000Z'),
      errorMessage: null,
    },
  ],
};

describe('<InterestPayload>', () => {
  beforeEach(() => {
    mockGetInterest.mockReset();
  });

  afterEach(() => cleanup());

  it('shows loading initially', () => {
    mockGetInterest.mockReturnValue(new Promise(() => {}));
    render(<InterestPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows error when fetch rejects', async () => {
    mockGetInterest.mockRejectedValue(new Error('boom'));
    render(<InterestPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('readonly mode renders description / searchQueries / linkedEntities / executions + onTitleReady', async () => {
    mockGetInterest.mockResolvedValue(baseDetail);
    const onTitleReady = vi.fn();

    render(
      <InterestPayload
        id={1}
        onTitleReady={onTitleReady}
        onNavigateEntity={vi.fn()}
        onAction={vi.fn().mockResolvedValue(undefined)}
        capabilities={INTEREST_CAPS}
      />,
    );

    expect(await screen.findByText('Daily AI updates')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText('LLM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'E10' })).toBeInTheDocument();
    expect(onTitleReady).toHaveBeenCalledWith('AI News');
  });

  it('enable toggle: optimistic flip on click, stays flipped on success', async () => {
    mockGetInterest.mockResolvedValue(baseDetail);
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <InterestPayload
        id={1}
        onTitleReady={vi.fn()}
        onNavigateEntity={vi.fn()}
        onAction={onAction}
        capabilities={INTEREST_CAPS}
      />,
    );
    const toggle = await screen.findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    expect(onAction).toHaveBeenCalledWith({
      type: 'setInterestEnabled',
      id: 1,
      enabled: false,
    });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });

  it('enable toggle: rollback to server state when onAction rejects', async () => {
    mockGetInterest.mockResolvedValue(baseDetail);
    const onAction = vi.fn().mockRejectedValue(new Error('network fail'));

    render(
      <InterestPayload
        id={1}
        onTitleReady={vi.fn()}
        onNavigateEntity={vi.fn()}
        onAction={onAction}
        capabilities={INTEREST_CAPS}
      />,
    );
    const toggle = await screen.findByRole('switch');
    await userEvent.click(toggle);
    // reject → setOptimisticEnabled(null) 回滚 → displayed state = server enabled (true)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('delete button dispatches deleteInterest action', async () => {
    mockGetInterest.mockResolvedValue(baseDetail);
    const onAction = vi.fn().mockResolvedValue(undefined);

    render(
      <InterestPayload
        id={1}
        onTitleReady={vi.fn()}
        onNavigateEntity={vi.fn()}
        onAction={onAction}
        capabilities={INTEREST_CAPS}
      />,
    );
    const delBtn = await screen.findByRole('button', {
      name: /interest_payload\.action_delete/,
    });
    await userEvent.click(delBtn);
    expect(onAction).toHaveBeenCalledWith({ type: 'deleteInterest', id: 1 });
  });

  it('edit button → form → submit → updateInterest action + back to readonly', async () => {
    mockGetInterest.mockResolvedValue(baseDetail);
    const onAction = vi.fn().mockResolvedValue(undefined);

    render(
      <InterestPayload
        id={1}
        onTitleReady={vi.fn()}
        onNavigateEntity={vi.fn()}
        onAction={onAction}
        capabilities={INTEREST_CAPS}
      />,
    );
    const editBtn = await screen.findByRole('button', {
      name: /interest_payload\.action_edit/,
    });
    await userEvent.click(editBtn);
    const formSubmit = screen.getByText('submit');
    await userEvent.click(formSubmit);
    expect(onAction).toHaveBeenCalledWith({
      type: 'updateInterest',
      id: 1,
      patch: { name: 'renamed' },
    });
    // submit 成功后回到 readonly：mock-form 应消失
    await waitFor(() => expect(screen.queryByTestId('mock-form')).toBeNull());
  });

  it('edit mode cancel → back to readonly without dispatching updateInterest', async () => {
    mockGetInterest.mockResolvedValue(baseDetail);
    const onAction = vi.fn().mockResolvedValue(undefined);

    render(
      <InterestPayload
        id={1}
        onTitleReady={vi.fn()}
        onNavigateEntity={vi.fn()}
        onAction={onAction}
        capabilities={INTEREST_CAPS}
      />,
    );
    const editBtn = await screen.findByRole('button', {
      name: /interest_payload\.action_edit/,
    });
    await userEvent.click(editBtn);
    await userEvent.click(screen.getByText('cancel'));
    await waitFor(() => expect(screen.queryByTestId('mock-form')).toBeNull());
    expect(onAction).not.toHaveBeenCalled();
  });

  it('linkedEntity chip click dispatches onNavigateEntity with kind=entity', async () => {
    mockGetInterest.mockResolvedValue(baseDetail);
    const onNavigateEntity = vi.fn();

    render(
      <InterestPayload
        id={1}
        onTitleReady={vi.fn()}
        onNavigateEntity={onNavigateEntity}
        onAction={vi.fn()}
        capabilities={INTEREST_CAPS}
      />,
    );
    const chip = await screen.findByRole('button', { name: 'E10' });
    await userEvent.click(chip);
    expect(onNavigateEntity).toHaveBeenCalledWith({ kind: 'entity', id: 10 });
  });

  it('onAction missing → edit / delete / enable-toggle all absent', async () => {
    mockGetInterest.mockResolvedValue(baseDetail);
    render(<InterestPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
    await screen.findByText('Daily AI updates');
    expect(screen.queryByRole('button', { name: /interest_payload\.action_delete/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /interest_payload\.action_edit/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('executions list renders status / itemsFound / itemsSubmitted', async () => {
    mockGetInterest.mockResolvedValue(baseDetail);
    render(<InterestPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
    await screen.findByText('Daily AI updates');
    // execution status is i18n-routed (execution_status_done) rather than the
    // raw 'done' enum value.
    expect(screen.getByText(/interest_payload\.execution_status_done/)).toBeInTheDocument();
    expect(screen.getByText(/n=5/)).toBeInTheDocument();
    expect(screen.getByText(/n=2/)).toBeInTheDocument();
  });

  it('executions empty + enabled → never_ran hint', async () => {
    mockGetInterest.mockResolvedValue({
      ...baseDetail,
      recentExecutions: [],
    });
    render(<InterestPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
    await screen.findByText(/interest_payload\.executions_empty_never_ran/);
  });

  it('executions empty + disabled → disabled hint', async () => {
    mockGetInterest.mockResolvedValue({
      ...baseDetail,
      interest: { ...baseDetail.interest, enabled: false },
      recentExecutions: [],
    });
    render(<InterestPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
    await screen.findByText(/interest_payload\.executions_empty_disabled/);
  });

  // Review round B-Pr-2: dirty bubble —— 覆盖 edit form dirty 通知
  it('edit form dirty signals → onDirtyChange(true); cancel → onDirtyChange(false)', async () => {
    mockGetInterest.mockResolvedValue(baseDetail);
    const onDirtyChange = vi.fn();

    render(
      <InterestPayload
        id={1}
        onTitleReady={vi.fn()}
        onNavigateEntity={vi.fn()}
        onAction={vi.fn().mockResolvedValue(undefined)}
        capabilities={INTEREST_CAPS}
        onDirtyChange={onDirtyChange}
      />,
    );
    const editBtn = await screen.findByRole('button', {
      name: /interest_payload\.action_edit/,
    });
    await userEvent.click(editBtn);
    await userEvent.click(screen.getByTestId('form-dirty-true'));
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
    onDirtyChange.mockClear();
    await userEvent.click(screen.getByTestId('form-cancel'));
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(false));
  });
});
