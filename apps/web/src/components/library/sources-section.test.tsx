import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, params?: Record<string, unknown>) => {
    const compiled = params
      ? `${ns}.${key}(${Object.entries(params)
          .map(([k, v]) => `${k}=${v}`)
          .join(',')})`
      : `${ns}.${key}`;
    return compiled;
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

import type { SourceListItem, SourceStatusCounts } from '@goldpan/web-sdk';
import { SourcesSection } from './sources-section';

const ZERO_COUNTS: SourceStatusCounts = {
  processing: 0,
  confirmed: 0,
  confirmed_empty: 0,
  failed: 0,
  discarded: 0,
};

function makeSource(over: Partial<SourceListItem> = {}): SourceListItem {
  return {
    id: 1,
    kind: 'external',
    originalUrl: 'https://example.com/a',
    normalizedUrl: 'https://example.com/a',
    title: 'Source A',
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

describe('SourcesSection — main list', () => {
  it('renders confirmed sources with KP pill + entity chips', () => {
    const s = makeSource({
      id: 7,
      title: 'Anthropic Launches Claude',
      status: 'confirmed',
      kpCount: 12,
      entityCount: 3,
      topEntities: [
        { id: 1, name: 'Anthropic' },
        { id: 2, name: 'Claude' },
        { id: 3, name: 'Anthropic Funding' },
      ],
    });
    render(
      <SourcesSection
        result={{ ok: [s] }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText('Anthropic Launches Claude')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Anthropic Funding')).toBeInTheDocument();
  });

  it('shows + N collapsed chip when entityCount > 3', () => {
    const s = makeSource({
      id: 8,
      entityCount: 7,
      topEntities: [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' },
      ],
    });
    render(
      <SourcesSection
        result={{ ok: [s] }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText('library.sources_entities_more(count=4)')).toBeInTheDocument();
  });

  it('source identity fallback: title → originalUrl → preview snippet → numeric', () => {
    const sources: SourceListItem[] = [
      makeSource({ id: 1, title: 'Has Title', originalUrl: null, kind: 'user', preview: null }),
      makeSource({
        id: 2,
        title: null,
        originalUrl: 'https://very-long-url.example.com/path/to/article-id-12345',
        kind: 'external',
      }),
      makeSource({
        id: 3,
        title: null,
        originalUrl: null,
        kind: 'user',
        preview: 'this is a user submitted opinion text',
      }),
      makeSource({ id: 4, title: null, originalUrl: null, kind: 'user', preview: null }),
    ];
    render(
      <SourcesSection
        result={{ ok: sources }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText('Has Title')).toBeInTheDocument();
    expect(
      screen.getByText(/very-long-url\.example\.com\/path\/to\/article-id-12345/),
    ).toBeInTheDocument();
    expect(screen.getByText(/this is a user submitted opinion text/)).toBeInTheDocument();
    expect(screen.getByText(/library\.source_untitled\(id=4\)/)).toBeInTheDocument();
  });

  it('treats whitespace-only title as missing (falls back to URL)', () => {
    render(
      <SourcesSection
        result={{
          ok: [
            makeSource({ id: 11, title: '   ', originalUrl: 'https://whitespace.example.com' }),
            makeSource({ id: 12, title: '', originalUrl: 'https://empty.example.com' }),
          ],
        }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText(/whitespace\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/empty\.example\.com/)).toBeInTheDocument();
  });

  it('external source with null originalUrl falls through to untitled placeholder', () => {
    render(
      <SourcesSection
        result={{
          ok: [makeSource({ id: 99, kind: 'external', title: null, originalUrl: null })],
        }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText(/library\.source_untitled\(id=99\)/)).toBeInTheDocument();
  });

  it('truncates external originalUrl to <= 60 chars + ellipsis (strips protocol)', () => {
    const longUrl = `https://${'sub.'.repeat(10)}example.com/path/article-id-${'X'.repeat(40)}`;
    const s = makeSource({ id: 5, title: null, originalUrl: longUrl, kind: 'external' });
    render(
      <SourcesSection
        result={{ ok: [s] }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    const text = screen.getByText(/sub\.sub\./);
    expect(text.textContent?.startsWith('https://')).toBe(false);
    expect(text.textContent?.endsWith('…')).toBe(true);
    expect((text.textContent ?? '').length).toBeLessThanOrEqual(61);
  });

  it('source kind label: external → URL, user → 用户文本', () => {
    render(
      <SourcesSection
        result={{
          ok: [
            makeSource({ id: 1, kind: 'external', title: 'Ext' }),
            makeSource({ id: 2, kind: 'user', title: null, preview: 'user note' }),
          ],
        }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText(/library\.source_kind_label_url/)).toBeInTheDocument();
    expect(screen.getByText(/library\.source_kind_label_user_text/)).toBeInTheDocument();
  });

  it('clicking a row dispatches onOpenPayload({kind:"source"})', async () => {
    const onOpenPayload = vi.fn();
    const s = makeSource({ id: 42, status: 'confirmed', title: 'Foo' });
    render(
      <SourcesSection
        result={{ ok: [s] }}
        onOpenPayload={onOpenPayload}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Foo/ }));
    expect(onOpenPayload).toHaveBeenCalledWith({ kind: 'source', id: 42 });
  });

  it('empty state when ok=[] and counts all zero', () => {
    render(
      <SourcesSection
        result={{ ok: [] }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText(/library\.sources_empty_title/)).toBeInTheDocument();
  });

  it('error state renders alert', () => {
    render(
      <SourcesSection
        result={{ error: 'boom' }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('SourcesSection — confirmed_empty fold group', () => {
  it('renders fold group when confirmed_empty > 0, default collapsed', () => {
    const sources: SourceListItem[] = [
      makeSource({
        id: 1,
        originalUrl: 'https://a.example.com',
        normalizedUrl: 'https://a.example.com',
        title: 'Confirmed One',
        kpCount: 1,
        entityCount: 1,
        topEntities: [{ id: 99, name: 'Acme' }],
      }),
      makeSource({
        id: 2,
        originalUrl: 'https://b.example.com',
        normalizedUrl: 'https://b.example.com',
        title: 'Empty One',
        status: 'confirmed_empty',
      }),
    ];
    render(
      <SourcesSection
        result={{ ok: sources }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    const head = screen.getByRole('button', { name: /sources_empty_group_title/ });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Empty One')).not.toBeInTheDocument();
  });

  it('expanding fold group reveals confirmed_empty rows without KP pill / chips', async () => {
    const sources: SourceListItem[] = [
      makeSource({
        id: 2,
        originalUrl: 'https://b.example.com',
        normalizedUrl: 'https://b.example.com',
        title: 'Empty One',
        status: 'confirmed_empty',
      }),
    ];
    render(
      <SourcesSection
        result={{ ok: sources }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /sources_empty_group_title/ }));
    const row = screen.getByRole('button', { name: /Empty One/ });
    // Muted rows skip the primary line entirely → no KP pill text.
    expect(within(row).queryByText('·KP')).not.toBeInTheDocument();
  });

  it('fold group hidden when confirmed_empty == 0', () => {
    render(
      <SourcesSection
        result={{ ok: [] }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.queryByText(/sources_empty_group_title/)).not.toBeInTheDocument();
  });
});

describe('SourcesSection — status indicator strip', () => {
  it('hidden when processing+failed+discarded all zero', () => {
    render(
      <SourcesSection
        result={{ ok: [] }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders only non-zero segments and links to /tasks', () => {
    render(
      <SourcesSection
        result={{ ok: [] }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={{
          processing: 2,
          confirmed: 5,
          confirmed_empty: 0,
          failed: 4,
          discarded: 0,
        }}
      />,
    );
    const strip = screen.getByRole('status');
    expect(strip.textContent).toContain('library.sources_status_seg_processing(count=2)');
    expect(strip.textContent).toContain('library.sources_status_seg_failed(count=4)');
    expect(strip.textContent).not.toContain('sources_status_seg_discarded');
    const link = within(strip).getByRole('link', { name: /sources_status_indicator_link/ });
    expect(link).toHaveAttribute('href', '/tasks');
  });

  it('shows discarded segment when only discarded > 0', () => {
    render(
      <SourcesSection
        result={{ ok: [] }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={{
          processing: 0,
          confirmed: 5,
          confirmed_empty: 0,
          failed: 0,
          discarded: 1,
        }}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain(
      'library.sources_status_seg_discarded(count=1)',
    );
  });

  it('hides the strip entirely when all status counts are zero', () => {
    render(
      <SourcesSection
        result={{ ok: [] }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('SourcesSection — category rail integration', () => {
  function makeWithCategoryPaths(id: number, paths: string[]): SourceListItem {
    return {
      id,
      kind: 'external',
      originalUrl: `https://${id}.example.com`,
      normalizedUrl: `https://${id}.example.com`,
      title: `Source ${id}`,
      status: 'confirmed',
      origin: 'user',
      createdAt: Date.parse('2026-04-22T00:00:00Z'),
      kpCount: 1,
      entityCount: 1,
      topEntities: [{ id: id * 10, name: `E${id}` }],
      entityCategoryPaths: paths,
      preview: null,
    };
  }

  it('shows all sources when category is empty string', () => {
    render(
      <SourcesSection
        result={{
          ok: [makeWithCategoryPaths(1, ['/Tech/AI']), makeWithCategoryPaths(2, ['/Business'])],
        }}
        onOpenPayload={vi.fn()}
        category=""
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText('Source 1')).toBeInTheDocument();
    expect(screen.getByText('Source 2')).toBeInTheDocument();
  });

  it('exact match with leading slash filters correctly', () => {
    render(
      <SourcesSection
        result={{
          ok: [makeWithCategoryPaths(1, ['/Tech/AI']), makeWithCategoryPaths(2, ['/Business'])],
        }}
        onOpenPayload={vi.fn()}
        category="/Tech/AI"
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText('Source 1')).toBeInTheDocument();
    expect(screen.queryByText('Source 2')).not.toBeInTheDocument();
  });

  it('parent category prefix matches deeper child paths', () => {
    render(
      <SourcesSection
        result={{
          ok: [
            makeWithCategoryPaths(1, ['/Tech/AI/Tools/ClaudeCode']),
            makeWithCategoryPaths(2, ['/Business']),
          ],
        }}
        onOpenPayload={vi.fn()}
        category="/Tech"
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText('Source 1')).toBeInTheDocument();
    expect(screen.queryByText('Source 2')).not.toBeInTheDocument();
  });

  it('matches when fixture path lacks leading slash but category has one', () => {
    render(
      <SourcesSection
        result={{
          ok: [makeWithCategoryPaths(1, ['Tech/AI'])],
        }}
        onOpenPayload={vi.fn()}
        category="/Tech/AI"
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText('Source 1')).toBeInTheDocument();
  });

  it('confirmed_empty fold group entirely hidden when category is set', () => {
    const empty: SourceListItem = {
      id: 99,
      kind: 'external',
      originalUrl: 'https://e.example.com',
      normalizedUrl: 'https://e.example.com',
      title: 'Empty Match',
      status: 'confirmed_empty',
      origin: 'user',
      createdAt: Date.parse('2026-04-22T00:00:00Z'),
      kpCount: 0,
      entityCount: 0,
      topEntities: [],
      entityCategoryPaths: [],
      preview: null,
    };
    render(
      <SourcesSection
        result={{ ok: [makeWithCategoryPaths(1, ['/Tech/AI']), empty] }}
        onOpenPayload={vi.fn()}
        category="/Tech/AI"
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText('Source 1')).toBeInTheDocument();
    expect(screen.queryByText(/sources_empty_group_title/)).not.toBeInTheDocument();
  });

  it('confirmed source with empty entityCategoryPaths is hidden when category is set', () => {
    render(
      <SourcesSection
        result={{
          ok: [makeWithCategoryPaths(1, []), makeWithCategoryPaths(2, ['/Tech/AI'])],
        }}
        onOpenPayload={vi.fn()}
        category="/Tech/AI"
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.queryByText('Source 1')).not.toBeInTheDocument();
    expect(screen.getByText('Source 2')).toBeInTheDocument();
    expect(screen.getByText(/sources_main_count_suffix\(count=1\)/)).toBeInTheDocument();
  });

  it('shows filtered-empty state with clear-category action when a category hides all confirmed', async () => {
    const onCategoryChange = vi.fn();
    render(
      <SourcesSection
        result={{ ok: [makeWithCategoryPaths(1, ['/Business'])] }}
        onOpenPayload={vi.fn()}
        category="/Tech/AI"
        onCategoryChange={onCategoryChange}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText('library.sources_empty_filtered_title')).toBeInTheDocument();
    const clearBtn = screen.getByRole('button', { name: /sources_empty_clear_category/ });
    await userEvent.click(clearBtn);
    expect(onCategoryChange).toHaveBeenCalledWith('');
  });

  it('shows global empty state (not filtered-empty) when there are no confirmed sources at all', () => {
    render(
      <SourcesSection
        result={{ ok: [] }}
        onOpenPayload={vi.fn()}
        category="/Tech/AI"
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText('library.sources_empty_title')).toBeInTheDocument();
    expect(screen.queryByText('library.sources_empty_filtered_title')).not.toBeInTheDocument();
  });

  it('main count suffix reflects post-filter count', () => {
    render(
      <SourcesSection
        result={{
          ok: [
            makeWithCategoryPaths(1, ['/Tech/AI']),
            makeWithCategoryPaths(2, ['/Business']),
            makeWithCategoryPaths(3, ['/Tech/AI']),
          ],
        }}
        onOpenPayload={vi.fn()}
        category="/Tech/AI"
        onCategoryChange={vi.fn()}
        counts={ZERO_COUNTS}
      />,
    );
    expect(screen.getByText(/sources_main_count_suffix\(count=2\)/)).toBeInTheDocument();
  });
});
