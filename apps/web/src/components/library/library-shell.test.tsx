import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

const mockRefresh = vi.fn();
const mockPush = vi.fn();
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: mockPush, replace: mockReplace }),
  usePathname: () => '/library',
  useSearchParams: () => new URLSearchParams(),
  // `rethrowNextErrors` (apps/web/src/lib/rethrow.ts) calls this. Real
  // `unstable_rethrow` is a no-op for plain Error instances and only re-throws
  // Next framework errors (NEXT_REDIRECT etc.). Tests here throw plain
  // `new Error('boom')`, which matches the no-op branch.
  unstable_rethrow: vi.fn(),
}));

const mockDiscardSource = vi.fn();
vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    discardSource: mockDiscardSource,
    createInterest: vi.fn(),
  }),
}));

// useInspectorUrlSync drives the URL; we only need to assert the shell calls
// `close` (the cb the hook hands back) after the confirm path resolves.
const mockClose = vi.fn();
const mockOpen = vi.fn();
vi.mock('../../hooks/use-inspector-url-sync', () => ({
  useInspectorUrlSync: () => ({ payload: null, open: mockOpen, close: mockClose }),
}));

// Capture the Inspector's handlers so tests can dispatch payload actions
// directly without driving the full Inspector UI. After the central
// dirty-guard refactor (PR #57) the shell no longer wraps onClose with a
// confirm prompt — Inspector owns that and is covered by inspector.test.tsx.
// Wrapped in an object so TS control-flow analysis does not narrow the field
// to `never` after the mock assignment.
type CapturedOnAction = (action: { type: 'discardSource'; id: number }) => Promise<void>;
const captured: {
  onAction?: CapturedOnAction;
  onClose?: () => void | Promise<void>;
} = {};
vi.mock('../inspector/inspector', () => ({
  Inspector: ({
    onAction,
    onClose,
  }: {
    onAction?: CapturedOnAction;
    onClose: () => void | Promise<void>;
  }) => {
    captured.onAction = onAction;
    captured.onClose = onClose;
    return <div data-testid="inspector-stub" />;
  },
}));

vi.mock('./category-rail', () => ({
  CategoryRail: () => null,
  useCategoryItems: () => [],
}));

vi.mock('./entities-section', () => ({
  EntitiesSection: () => <h2>section_entities</h2>,
}));

vi.mock('./notes-section', () => ({
  NotesSection: () => <h2>section_notes</h2>,
}));

vi.mock('./sources-section', () => ({
  SourcesSection: ({ result }: { result: { ok?: Array<{ id: number; title: string }> } }) => (
    <>
      <h2>section_sources</h2>
      <div data-testid="sources-list">
        {result.ok?.map((s) => (
          <span key={s.id} data-testid={`source-${s.id}`}>
            {s.title}
          </span>
        ))}
      </div>
    </>
  ),
}));

import type { Entity, SourceListItem, SourceStatusCounts } from '@goldpan/web-sdk';
import { LibraryShell } from './library-shell';

const ZERO_COUNTS: SourceStatusCounts = {
  processing: 0,
  confirmed: 0,
  confirmed_empty: 0,
  failed: 0,
  discarded: 0,
};

function makeSource(over: Partial<SourceListItem>): SourceListItem {
  return {
    id: 1,
    kind: 'external',
    originalUrl: 'https://example.com',
    normalizedUrl: 'https://example.com',
    title: `Source ${over.id ?? 1}`,
    status: 'confirmed',
    origin: 'user',
    createdAt: Date.parse('2026-04-22T00:00:00Z'),
    kpCount: 0,
    entityCount: 0,
    topEntities: [],
    entityCategoryPaths: [],
    preview: null,
    ...over,
  };
}

describe('LibraryShell — discardSource reducer', () => {
  it('removes the discarded source from the list and triggers router.refresh', async () => {
    mockDiscardSource.mockResolvedValueOnce(undefined);
    captured.onAction = undefined;
    mockRefresh.mockClear();

    render(
      <LibraryShell
        entitiesResult={{ ok: [] as Entity[] }}
        notesResult={{ ok: [] }}
        archivedNotes={[]}
        sourcesResult={{ ok: [makeSource({ id: 1 }), makeSource({ id: 2 })] }}
        counts={ZERO_COUNTS}
      />,
    );

    expect(screen.getByTestId('source-1')).toBeInTheDocument();
    expect(screen.getByTestId('source-2')).toBeInTheDocument();
    expect(captured.onAction).toBeDefined();

    const onAction = captured.onAction as CapturedOnAction | undefined;
    if (!onAction) throw new Error('Inspector did not receive onAction');
    await onAction({ type: 'discardSource', id: 1 });

    await waitFor(() => {
      expect(screen.queryByTestId('source-1')).toBeNull();
    });
    expect(screen.getByTestId('source-2')).toBeInTheDocument();
    expect(mockDiscardSource).toHaveBeenCalledWith(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('rolls back the optimistic filter and re-throws when discardSource fails', async () => {
    mockDiscardSource.mockRejectedValueOnce(new Error('boom'));
    captured.onAction = undefined;
    mockRefresh.mockClear();

    render(
      <LibraryShell
        entitiesResult={{ ok: [] as Entity[] }}
        notesResult={{ ok: [] }}
        archivedNotes={[]}
        sourcesResult={{ ok: [makeSource({ id: 1 }), makeSource({ id: 2 })] }}
        counts={ZERO_COUNTS}
      />,
    );

    const onAction = captured.onAction as CapturedOnAction | undefined;
    if (!onAction) throw new Error('Inspector did not receive onAction');
    // Payload-side handlers rely on rejection to render their inline alert;
    // resolving here would let inspector flip status while the row reappears.
    await expect(onAction({ type: 'discardSource', id: 1 })).rejects.toThrow('boom');

    // Source 1 reappears after the rollback.
    await waitFor(() => {
      expect(screen.getByTestId('source-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('source-2')).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows the failure toast when discardSource rejects', async () => {
    mockDiscardSource.mockRejectedValueOnce(new Error('boom'));
    captured.onAction = undefined;

    render(
      <LibraryShell
        entitiesResult={{ ok: [] as Entity[] }}
        notesResult={{ ok: [] }}
        archivedNotes={[]}
        sourcesResult={{ ok: [makeSource({ id: 1 })] }}
        counts={ZERO_COUNTS}
      />,
    );

    const onAction = captured.onAction as CapturedOnAction | undefined;
    if (!onAction) throw new Error('Inspector did not receive onAction');
    await expect(onAction({ type: 'discardSource', id: 1 })).rejects.toThrow('boom');

    await waitFor(() => {
      expect(screen.getByText('toast_source_discard_failed')).toBeInTheDocument();
    });
  });

  it('renders NotesSection between EntitiesSection and SourcesSection', () => {
    render(
      <LibraryShell
        entitiesResult={{ ok: [] as Entity[] }}
        notesResult={{ ok: [] }}
        archivedNotes={[]}
        sourcesResult={{ ok: [] }}
        counts={ZERO_COUNTS}
      />,
    );
    // 三 section heading order — Entities → Notes → Sources
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      expect.stringMatching(/section_entities|实体/),
      expect.stringMatching(/section_notes|笔记/),
      expect.stringMatching(/section_sources|来源/),
    ]);
  });
});
