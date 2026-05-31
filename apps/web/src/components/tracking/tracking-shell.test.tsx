import type { InterestListItem } from '@goldpan/web-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// hoisted mocks so factory closures can reference them
const mocks = vi.hoisted(() => ({
  apiClient: {
    createInterest: vi.fn(),
    getInterests: vi.fn(),
    deleteInterest: vi.fn(),
    enableInterest: vi.fn(),
    disableInterest: vi.fn(),
    updateInterest: vi.fn(),
  },
  closeFn: vi.fn(),
  openFn: vi.fn(),
  routerReplace: vi.fn(),
  confirmMock: vi.fn(),
}));

vi.mock('@/components/confirm-provider', () => ({
  useConfirm: () => mocks.confirmMock,
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => mocks.apiClient,
}));

vi.mock('../../hooks/use-inspector-url-sync', () => ({
  useInspectorUrlSync: () => ({
    payload: { kind: 'interest', id: 7 },
    open: mocks.openFn,
    close: mocks.closeFn,
  }),
}));

let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.routerReplace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => mockSearchParams,
}));

// Stub InterestsSection: exposes a `submit-new` button that triggers onSubmitNew.
// `data-show-new-form` reflects the `showNewForm` prop so mount-effect tests
// can verify the user-visible form-open state, not just the URL strip.
vi.mock('./interests-section', () => ({
  InterestsSection: ({
    onSubmitNew,
    onOpenInterest,
    onToggleNewForm,
    showNewForm,
    searchToolWarning,
  }: {
    onSubmitNew: (d: unknown) => Promise<void>;
    onOpenInterest: (id: number) => void;
    onToggleNewForm: () => void;
    showNewForm: boolean;
    searchToolWarning?: boolean;
  }) => (
    <div
      data-testid="interests-section-stub"
      data-show-new-form={String(showNewForm)}
      data-search-tool-warning={String(searchToolWarning ?? false)}
    >
      <button
        type="button"
        data-testid="submit-new"
        onClick={() => onSubmitNew({ name: 'A', searchQueries: ['a'] } as unknown).catch(() => {})}
      >
        submit
      </button>
      <button type="button" data-testid="open-42" onClick={() => onOpenInterest(42)}>
        open 42
      </button>
      <button type="button" data-testid="toggle-new" onClick={onToggleNewForm}>
        toggle
      </button>
    </div>
  ),
}));

// Stub Inspector: exposes fire-action-* buttons that drive the shell's
// handleAction dispatcher. After PR #57 the dirty-edit close guard moved into
// Inspector (covered by inspector.test.tsx), so this stub no longer needs to
// expose onDirtyChange / onClose firing hooks — shell tests focus on the
// action dispatcher contract instead.
vi.mock('../inspector/inspector', () => ({
  Inspector: ({ onAction }: { onAction?: (a: unknown) => Promise<void> }) => (
    <div data-testid="inspector-stub">
      <button
        type="button"
        data-testid="fire-delete"
        onClick={() => onAction?.({ type: 'deleteInterest', id: 7 }).catch(() => {})}
      >
        delete
      </button>
      <button
        type="button"
        data-testid="fire-toggle-enable-off"
        onClick={() =>
          onAction?.({ type: 'setInterestEnabled', id: 7, enabled: false }).catch(() => {})
        }
      >
        toggle off
      </button>
      <button
        type="button"
        data-testid="fire-update"
        onClick={() =>
          onAction?.({
            type: 'updateInterest',
            id: 7,
            patch: { name: 'renamed' },
          }).catch(() => {})
        }
      >
        update
      </button>
      <button
        type="button"
        data-testid="fire-track-from-entity"
        onClick={() =>
          onAction?.({ type: 'trackFromEntity', entityId: 1, entityName: 'X' }).catch(() => {})
        }
      >
        trackFromEntity (no-op in tracking shell)
      </button>
    </div>
  ),
}));

import { TrackingShell } from './tracking-shell';

function fixture(overrides: Partial<InterestListItem> = {}): InterestListItem {
  return {
    id: 7,
    name: 'old',
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

function renderShell(interests: InterestListItem[] = [fixture()], searchToolWarning = false) {
  return render(
    <NextIntlClientProvider
      locale="zh"
      messages={{
        tracking: {
          confirm_delete: '确认删除此追踪项？',
          create_refetch_failed: '列表刷新失败',
          dismiss: '关闭提示',
        },
        inspector: {
          back_fallback: '返回',
          close: '关闭',
          kind_interest: '追踪项',
        },
      }}
    >
      <TrackingShell interestsResult={{ ok: interests }} searchToolWarning={searchToolWarning} />
    </NextIntlClientProvider>,
  );
}

// B-Pr-2 unsaved-edit close guard moved into Inspector (PR #57) — Inspector
// now owns the confirm prompt for all leave paths (Esc / backdrop / ✕ / Back /
// linked-entity push). Tracking shell no longer wraps `onClose` or threads
// `onDirtyChange`. Those tests now live in `inspector.test.tsx`.

describe('<TrackingShell> handleAction dispatcher', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.apiClient)) fn.mockReset();
    mocks.closeFn.mockReset();
    mocks.openFn.mockReset();
    mocks.routerReplace.mockReset();
    mocks.confirmMock.mockReset();
  });

  it('deleteInterest → confirm ok → client.deleteInterest + close', async () => {
    mocks.confirmMock.mockResolvedValueOnce(true);
    mocks.apiClient.deleteInterest.mockResolvedValue(undefined);
    renderShell();
    fireEvent.click(screen.getByTestId('fire-delete'));
    await waitFor(() => {
      expect(mocks.apiClient.deleteInterest).toHaveBeenCalledWith(7);
      expect(mocks.closeFn).toHaveBeenCalled();
    });
  });

  it('deleteInterest → confirm cancel → no SDK call', async () => {
    mocks.confirmMock.mockResolvedValueOnce(false);
    renderShell();
    fireEvent.click(screen.getByTestId('fire-delete'));
    await waitFor(() => expect(mocks.confirmMock).toHaveBeenCalled());
    expect(mocks.apiClient.deleteInterest).not.toHaveBeenCalled();
  });

  it('setInterestEnabled=false → client.disableInterest', async () => {
    mocks.apiClient.disableInterest.mockResolvedValue(undefined);
    renderShell();
    fireEvent.click(screen.getByTestId('fire-toggle-enable-off'));
    await waitFor(() => expect(mocks.apiClient.disableInterest).toHaveBeenCalledWith(7));
  });

  it('updateInterest → client.updateInterest with patch', async () => {
    mocks.apiClient.updateInterest.mockResolvedValue({ id: 7, name: 'renamed' });
    renderShell();
    fireEvent.click(screen.getByTestId('fire-update'));
    await waitFor(() =>
      expect(mocks.apiClient.updateInterest).toHaveBeenCalledWith(7, { name: 'renamed' }),
    );
  });

  it('trackFromEntity is a no-op in TrackingShell (never throws)', async () => {
    renderShell();
    // should not error; no SDK call
    fireEvent.click(screen.getByTestId('fire-track-from-entity'));
    await waitFor(() => {
      expect(mocks.apiClient.createInterest).not.toHaveBeenCalled();
      expect(mocks.routerReplace).not.toHaveBeenCalled();
    });
  });
});

describe('<TrackingShell> B-Pr-5 handleCreate refetch fallback', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.apiClient)) fn.mockReset();
    mocks.routerReplace.mockReset();
  });

  it('refetch succeeds → override uses refetched list', async () => {
    mocks.apiClient.createInterest.mockResolvedValue({
      id: 42,
      name: 'A',
      description: null,
      searchQueries: ['a'],
      toolProvider: null,
      intervalMinutes: 60,
      enabled: true,
      status: 'idle',
      lastRunAt: null,
      nextRunAt: null,
      linkedEntityIds: [],
      createdAt: 0,
      updatedAt: 0,
    });
    mocks.apiClient.getInterests.mockResolvedValue({
      data: [fixture({ id: 42, name: 'A-refetched' })],
      total: 1,
    });
    renderShell();
    fireEvent.click(screen.getByTestId('submit-new'));
    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith('/tracking?focus=42&kind=interest');
    });
    expect(screen.queryByText(/列表刷新失败/)).not.toBeInTheDocument();
  });

  it('refetch fails → append created + banner + still navigates', async () => {
    mocks.apiClient.createInterest.mockResolvedValue({
      id: 42,
      name: 'A',
      description: null,
      searchQueries: ['a'],
      toolProvider: null,
      intervalMinutes: 60,
      enabled: true,
      status: 'idle',
      lastRunAt: null,
      nextRunAt: null,
      linkedEntityIds: [],
      createdAt: 0,
      updatedAt: 0,
    });
    mocks.apiClient.getInterests.mockRejectedValue(new Error('network'));
    renderShell();
    fireEvent.click(screen.getByTestId('submit-new'));
    await waitFor(() => {
      expect(screen.getByText(/列表刷新失败/)).toBeInTheDocument();
    });
    expect(mocks.routerReplace).toHaveBeenCalledWith('/tracking?focus=42&kind=interest');
  });

  it('dismiss banner button clears createWarning', async () => {
    mocks.apiClient.createInterest.mockResolvedValue({
      id: 42,
      name: 'A',
      description: null,
      searchQueries: ['a'],
      toolProvider: null,
      intervalMinutes: 60,
      enabled: true,
      status: 'idle',
      lastRunAt: null,
      nextRunAt: null,
      linkedEntityIds: [],
      createdAt: 0,
      updatedAt: 0,
    });
    mocks.apiClient.getInterests.mockRejectedValue(new Error('network'));
    renderShell();
    fireEvent.click(screen.getByTestId('submit-new'));
    const warning = await screen.findByText(/列表刷新失败/);
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(warning).not.toBeInTheDocument();
  });
});

describe('<TrackingShell> URL sync plumbing', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.apiClient)) fn.mockReset();
    mocks.openFn.mockReset();
  });

  it('onOpenInterest(id) → open({kind: "interest", id})', () => {
    renderShell();
    fireEvent.click(screen.getByTestId('open-42'));
    expect(mocks.openFn).toHaveBeenCalledWith({ kind: 'interest', id: 42 });
  });
});

describe('<TrackingShell> S10 ?new=1 mount effect', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.apiClient)) fn.mockReset();
    mocks.routerReplace.mockReset();
    mockSearchParams = new URLSearchParams();
  });

  it('?new=1 only → showNewForm=true + replace("/tracking")', () => {
    mockSearchParams = new URLSearchParams('new=1');
    renderShell();
    expect(mocks.routerReplace).toHaveBeenCalledWith('/tracking');
    expect(screen.getByTestId('interests-section-stub').dataset.showNewForm).toBe('true');
  });

  it('?new=1 with focus=42&kind=interest → preserve other query, strip only new, form opens', () => {
    mockSearchParams = new URLSearchParams('focus=42&kind=interest&new=1');
    renderShell();
    expect(mocks.routerReplace).toHaveBeenCalledWith('/tracking?focus=42&kind=interest');
    expect(screen.getByTestId('interests-section-stub').dataset.showNewForm).toBe('true');
  });

  it('?new=1 strips URL but does not open the form while search setup is missing', () => {
    mockSearchParams = new URLSearchParams('new=1');
    renderShell([fixture()], true);
    expect(mocks.routerReplace).toHaveBeenCalledWith('/tracking');
    expect(screen.getByTestId('interests-section-stub').dataset.showNewForm).toBe('false');
    fireEvent.click(screen.getByTestId('toggle-new'));
    expect(screen.getByTestId('interests-section-stub').dataset.showNewForm).toBe('false');
  });

  it('no ?new param → no replace call, form stays closed', () => {
    mockSearchParams = new URLSearchParams('focus=42');
    renderShell();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
    expect(screen.getByTestId('interests-section-stub').dataset.showNewForm).toBe('false');
  });
});
