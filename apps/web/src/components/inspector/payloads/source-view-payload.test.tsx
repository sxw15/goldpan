import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, params?: Record<string, unknown>) => {
    if (!params) return `${ns}.${key}`;
    const entries = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${ns}.${key}(${entries})`;
  },
}));

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('@/components/confirm-provider', () => ({
  useConfirm: () => confirmMock,
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const mockGetSourceView = vi.fn();

vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    getSourceView: mockGetSourceView,
  }),
}));

import { SourceViewPayload } from './source-view-payload';
import type { PayloadAction, PayloadCapabilitySet } from './types';

const DISCARD_CAPS: PayloadCapabilitySet = new Set<PayloadAction['type']>([
  'discardSource',
  'trackFromEntity',
]);

const baseSourceView = {
  source: {
    id: 1,
    kind: 'external',
    normalizedUrl: 'https://a.test',
    originalUrl: 'https://a.test',
    title: 'Test',
    rawContent: null,
    metadata: null,
    status: 'confirmed',
    createdAt: Date.parse('2026-04-01T10:00:00.000Z'),
    updatedAt: Date.parse('2026-04-01T10:00:00.000Z'),
    origin: 'user',
    trackingRuleId: null,
  },
  entities: [
    {
      entityId: 10,
      entityName: 'E10',
      points: [{ id: 100, content: 'fact-content', contentTranslated: null, type: 'fact' }],
    },
  ],
  categoryPaths: ['Tech/AI'],
  tags: ['ai', 'llm'],
};

describe('<SourceViewPayload>', () => {
  beforeEach(() => {
    mockGetSourceView.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  afterEach(() => cleanup());

  it('shows loading initially', () => {
    mockGetSourceView.mockReturnValue(new Promise(() => {}));
    render(<SourceViewPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows error when fetch rejects', async () => {
    mockGetSourceView.mockRejectedValue(new Error('boom'));
    render(<SourceViewPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('loads SourceViewDetail then renders source meta + tags + categoryPaths + knowledge groups', async () => {
    mockGetSourceView.mockResolvedValue(baseSourceView);
    const onTitleReady = vi.fn();
    render(<SourceViewPayload id={1} onTitleReady={onTitleReady} onNavigateEntity={vi.fn()} />);

    // Title 'Test' is rendered by InspectorHeader (via onTitleReady), not the
    // payload body, to avoid duplicate-title visual. Wait on a body element.
    expect(await screen.findByText('E10')).toBeInTheDocument();
    expect(screen.getByText('fact-content')).toBeInTheDocument();
    expect(screen.getByText('ai')).toBeInTheDocument();
    expect(screen.getByText('llm')).toBeInTheDocument();
    expect(screen.getByText('Tech/AI')).toBeInTheDocument();
    expect(onTitleReady).toHaveBeenCalledWith('Test');
  });

  it('clicking entity group name dispatches onNavigateEntity', async () => {
    mockGetSourceView.mockResolvedValue({
      ...baseSourceView,
      entities: [{ entityId: 42, entityName: 'E42', points: [] }],
    });
    const onNavigateEntity = vi.fn();
    render(<SourceViewPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={onNavigateEntity} />);
    const btn = await screen.findByRole('button', { name: 'E42' });
    await userEvent.click(btn);
    expect(onNavigateEntity).toHaveBeenCalledWith({ kind: 'entity', id: 42 });
  });

  it('renders StateEmpty when entities + tags + categoryPaths all empty', async () => {
    mockGetSourceView.mockResolvedValue({
      source: {
        ...baseSourceView.source,
        title: null,
        status: 'confirmed_empty',
      },
      entities: [],
      categoryPaths: [],
      tags: [],
    });
    render(<SourceViewPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
    expect(await screen.findByText(/source_view_payload\.empty_title/)).toBeInTheDocument();
  });

  it('source originalUrl renders with rel="noopener noreferrer" and target="_blank"', async () => {
    mockGetSourceView.mockResolvedValue(baseSourceView);
    render(<SourceViewPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
    const link = await screen.findByRole('link', { name: 'https://a.test' });
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('falls back to originalUrl when title is null', async () => {
    mockGetSourceView.mockResolvedValue({
      ...baseSourceView,
      source: { ...baseSourceView.source, title: null },
    });
    const onTitleReady = vi.fn();
    render(<SourceViewPayload id={1} onTitleReady={onTitleReady} onNavigateEntity={vi.fn()} />);
    await screen.findByRole('link', { name: 'https://a.test' });
    expect(onTitleReady).toHaveBeenCalledWith('https://a.test');
  });

  it('falls back to Source #id when both title and originalUrl are null', async () => {
    mockGetSourceView.mockResolvedValue({
      ...baseSourceView,
      source: { ...baseSourceView.source, title: null, originalUrl: null, normalizedUrl: null },
      entities: [],
      tags: [],
      categoryPaths: [],
    });
    const onTitleReady = vi.fn();
    render(<SourceViewPayload id={7} onTitleReady={onTitleReady} onNavigateEntity={vi.fn()} />);
    await screen.findByText(/source_view_payload\.empty_title/);
    // i18n-routed via library.source_title_fallback with param id=7
    expect(onTitleReady).toHaveBeenCalledWith('library.source_title_fallback(id=7)');
  });

  // C4 regression: confirmed sources route through SourceViewPayload (the
  // only detail view for inspector kind=source), so SourceViewPayload must expose the
  // discard action — otherwise Library loses the management path for every
  // confirmed source.
  describe('discard action (C4)', () => {
    it('renders discard button when confirmed + capability contains discardSource', async () => {
      mockGetSourceView.mockResolvedValue(baseSourceView);
      render(
        <SourceViewPayload
          id={1}
          onTitleReady={vi.fn()}
          onNavigateEntity={vi.fn()}
          onAction={vi.fn()}
          capabilities={DISCARD_CAPS}
        />,
      );
      expect(
        await screen.findByRole('button', { name: /library\.source_action_discard/ }),
      ).toBeInTheDocument();
    });

    it('discard confirm → dispatches onAction({type:"discardSource", id})', async () => {
      mockGetSourceView.mockResolvedValue(baseSourceView);
      const onAction = vi.fn().mockResolvedValue(undefined);
      confirmMock.mockResolvedValueOnce(true);
      render(
        <SourceViewPayload
          id={1}
          onTitleReady={vi.fn()}
          onNavigateEntity={vi.fn()}
          onAction={onAction}
          capabilities={DISCARD_CAPS}
        />,
      );
      const btn = await screen.findByRole('button', {
        name: /library\.source_action_discard/,
      });
      await userEvent.click(btn);
      expect(onAction).toHaveBeenCalledWith({ type: 'discardSource', id: 1 });
    });

    it('discard hidden when onAction absent (read-only shell)', async () => {
      mockGetSourceView.mockResolvedValue(baseSourceView);
      render(<SourceViewPayload id={1} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} />);
      await screen.findByText('E10');
      expect(screen.queryByRole('button', { name: /library\.source_action_discard/ })).toBeNull();
    });

    it('discard hidden when source status is not discardable', async () => {
      mockGetSourceView.mockResolvedValue({
        ...baseSourceView,
        source: { ...baseSourceView.source, status: 'discarded' },
      });
      render(
        <SourceViewPayload
          id={1}
          onTitleReady={vi.fn()}
          onNavigateEntity={vi.fn()}
          onAction={vi.fn()}
          capabilities={DISCARD_CAPS}
        />,
      );
      await screen.findByText('E10');
      expect(screen.queryByRole('button', { name: /library\.source_action_discard/ })).toBeNull();
    });
  });
});
