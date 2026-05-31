import type { NoteDetail } from '@goldpan/web-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { TzProvider } from '@/components/tz-provider';
import messages from '../../../messages/zh.json';
import { NotesSection } from './notes-section';

// TG7 — NotesSection error envelope path: `result.error` must render the
// StateError component with a retry button wired to `router.refresh()`. Mock
// the router so the assertion can verify the wiring without a full Next runtime.
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
}));

// 帮助：精确取到 filter chip（subtype 文本 "笔记" 同时出现在 filter chip 和
// NoteCard 的 subtype chip 里，单纯 getByRole('button', { name: /笔记/ }) 会
// 匹配到多个 button，所以按 class 限定到 filter 区域。）
function getFilterChip(label: RegExp): HTMLElement {
  const chips = screen
    .getAllByRole('button')
    .filter((b) => b.classList.contains('gp-notes-section__filter-chip'));
  const match = chips.find((b) => label.test(b.textContent ?? ''));
  if (!match) {
    throw new Error(`filter chip not found: ${label}`);
  }
  return match;
}

const notesFixture: NoteDetail[] = [
  {
    id: 1,
    content: 'note 1',
    subtype: 'note',
    tags: [],
    linkedEntities: [],
    linkedSources: [],
    pinned: false,
    archived: false,
    sourceMessageId: null,
    conversationId: null,
    contentTranslated: null,
    language: null,
    dueAt: null,
    remindedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
  },
  {
    id: 2,
    content: 'memo 1',
    subtype: 'memo',
    tags: [],
    linkedEntities: [],
    linkedSources: [],
    pinned: false,
    archived: false,
    sourceMessageId: null,
    conversationId: null,
    contentTranslated: null,
    language: null,
    dueAt: null,
    remindedAt: null,
    createdAt: 2000,
    updatedAt: 2000,
  },
];

const archivedFixture: NoteDetail[] = [
  {
    id: 101,
    content: 'archived note',
    subtype: 'note',
    tags: [],
    linkedEntities: [],
    linkedSources: [],
    pinned: false,
    archived: true,
    sourceMessageId: null,
    conversationId: null,
    contentTranslated: null,
    language: null,
    dueAt: null,
    remindedAt: null,
    createdAt: 500,
    updatedAt: 500,
  },
];

function setup(archived: NoteDetail[] = [], archivedNotesError?: string) {
  return render(
    <NextIntlClientProvider locale="zh" messages={messages} timeZone="UTC">
      <TzProvider tz="UTC">
        <NotesSection
          result={{ ok: notesFixture }}
          archivedNotes={archived}
          archivedNotesError={archivedNotesError}
          onOpenPayload={vi.fn()}
        />
      </TzProvider>
    </NextIntlClientProvider>,
  );
}

describe('NotesSection', () => {
  it('renders all notes on default (filter=all)', () => {
    setup();
    expect(screen.getByText('note 1')).toBeInTheDocument();
    expect(screen.getByText('memo 1')).toBeInTheDocument();
  });

  it('filters by subtype chip click', () => {
    setup();
    fireEvent.click(getFilterChip(/笔记/));
    expect(screen.getByText('note 1')).toBeInTheDocument();
    expect(screen.queryByText('memo 1')).not.toBeInTheDocument();
  });

  it('shows StateEmpty when filtered to a subtype with no matches', () => {
    // 给两个 note fixture 都不是 memo —— filter 切到 memo 后应为空。
    render(
      <NextIntlClientProvider locale="zh" messages={messages} timeZone="UTC">
        <TzProvider tz="UTC">
          <NotesSection
            result={{ ok: [notesFixture[0]] }}
            archivedNotes={[]}
            onOpenPayload={vi.fn()}
          />
        </TzProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(getFilterChip(/备忘/)); // memo, fixture 里没有
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument();
  });

  it('renders StateEmpty (with note-write hint) when no notes at all', () => {
    render(
      <NextIntlClientProvider locale="zh" messages={messages} timeZone="UTC">
        <TzProvider tz="UTC">
          <NotesSection result={{ ok: [] }} archivedNotes={[]} onOpenPayload={vi.fn()} />
        </TzProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/还没有笔记/)).toBeInTheDocument();
  });

  // TG7 — error envelope (`result.error`) must render the error message text
  // plus an actionable retry button wired to router.refresh(). Mirrors how
  // EntitiesSection / SourcesSection surface section-level fetch failures.
  it('TG7: renders StateError with message + retry button when result has error', () => {
    refreshMock.mockReset();
    render(
      <NextIntlClientProvider locale="zh" messages={messages} timeZone="UTC">
        <TzProvider tz="UTC">
          <NotesSection result={{ error: '加载失败' }} archivedNotes={[]} onOpenPayload={vi.fn()} />
        </TzProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('加载失败')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /重试/ });
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  // F-ARCHIVE-NO-RECOVERY-UI — archived view tests.
  //
  // The archived filter chip is a distinct view that swaps the rendered list
  // from `result.ok` (active notes) to the `archivedNotes` prop. Tests cover:
  // 1. chip renders with correct count
  // 2. clicking the chip swaps the visible list and hides active rows
  // 3. archived view shows its own empty state (different copy) when empty
  // 4. switching to archived swaps the section title

  it('archived filter chip shows count from archivedNotes prop', () => {
    setup(archivedFixture);
    const archivedChip = getFilterChip(/归档/);
    expect(archivedChip.textContent).toContain('1');
  });

  it('clicking archived chip swaps rendered list to archivedNotes (active rows hidden)', () => {
    setup(archivedFixture);
    fireEvent.click(getFilterChip(/归档/));
    expect(screen.getByText('archived note')).toBeInTheDocument();
    expect(screen.queryByText('note 1')).not.toBeInTheDocument();
    expect(screen.queryByText('memo 1')).not.toBeInTheDocument();
  });

  it('archived view shows the archived-specific empty state when archivedNotes=[]', () => {
    setup([]);
    fireEvent.click(getFilterChip(/归档/));
    expect(screen.getByText(/没有归档的笔记/)).toBeInTheDocument();
    // Also confirm we did NOT fall back to the generic empty hint.
    expect(screen.queryByText(/还没有笔记$/)).not.toBeInTheDocument();
  });

  it('archived view shows retryable error when archived fetch failed', () => {
    refreshMock.mockReset();
    setup([], '加载归档笔记失败，请重试');
    const archivedChip = getFilterChip(/归档/);
    expect(archivedChip.textContent).toContain('!');
    expect(archivedChip.textContent).not.toContain('0');
    expect(archivedChip).toHaveAttribute('title', '加载归档笔记失败，请重试');
    fireEvent.click(archivedChip);
    expect(screen.getByRole('heading', { name: '归档笔记' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('加载归档笔记失败，请重试');
    const retryBtn = screen.getByRole('button', { name: /重试/ });
    fireEvent.click(retryBtn);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('section title swaps to archived heading when archived chip is active', () => {
    setup(archivedFixture);
    // Default section title is "笔记" — switching shows "归档笔记".
    fireEvent.click(getFilterChip(/归档/));
    expect(screen.getByRole('heading', { name: /归档笔记/ })).toBeInTheDocument();
  });

  it('archived chip is independent of subtype counts (archived not added to memo/note)', () => {
    setup(archivedFixture);
    // archived fixture has subtype=note, but the `note` chip count should
    // still reflect only the active notes (1 active note), not 1 + 1.
    const noteChip = getFilterChip(/^笔记/);
    expect(noteChip.textContent).toMatch(/1$/);
  });
});
