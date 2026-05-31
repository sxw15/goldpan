import { GoldpanApiError } from '@goldpan/web-sdk';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P7.2: useLocale needs to be swappable per-test (translate button visibility
// depends on `detail.language !== locale`). vi.hoisted guarantees the ref
// exists at the time vi.mock factories run (hoisted above imports).
const { mockLocale } = vi.hoisted(() => ({
  mockLocale: { current: 'zh' as 'zh' | 'en' },
}));

// Match the existing inspector-payload test convention: stub next-intl so
// assertions can read the rendered i18n key + interpolation params.
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, params?: Record<string, unknown>) => {
    if (!params) return `${ns}.${key}`;
    const entries = Object.entries(params)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(',');
    return `${ns}.${key}(${entries})`;
  },
  useLocale: () => mockLocale.current,
}));

// Mock the next/navigation router — NotePayload uses `router.refresh()`
// after delete and `router.push(...)` after reclassify.
const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock, replace: vi.fn() }),
}));

// Reuse the same hoisted-mock pattern used in note-payload.test.tsx so we
// can drive `useConfirm()` from the test side. ConfirmProvider is a no-op
// passthrough — the real dialog UI isn't under test here.
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('@/components/confirm-provider', () => ({
  useConfirm: () => confirmMock,
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockInput = vi.fn();
const mockPromote = vi.fn();
const mockTranslate = vi.fn();
const mockLookupEntities = vi.fn();
const promotableContent = `${'promotable note content '.repeat(30)}tail`;

vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    getNote: mockGet,
    updateNote: mockUpdate,
    deleteNote: mockDelete,
    input: mockInput,
    promoteNote: mockPromote,
    translateNote: mockTranslate,
    lookupEntitiesByName: mockLookupEntities,
  }),
}));

import { NotePayload } from './note-payload';

const originalNotification = window.Notification;

const noteFixture = {
  id: 7,
  content: 'orig',
  contentTranslated: null,
  language: null,
  subtype: 'note' as const,
  pinned: false,
  archived: false,
  sourceMessageId: null,
  conversationId: null,
  tags: ['t1', 't2'],
  linkedEntities: [
    { id: 1, name: 'E1' },
    { id: 2, name: 'E2' },
  ],
  linkedSources: [
    {
      id: 11,
      relation: 'reference' as const,
      title: 'S1',
      originalUrl: 'https://s1',
    },
  ],
  dueAt: null,
  remindedAt: null,
  createdAt: Date.parse('2026-04-01T10:00:00.000Z'),
  updatedAt: Date.parse('2026-04-01T10:00:00.000Z'),
};

function renderPayload(extra?: {
  id?: number;
  onClose?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  return render(
    <NotePayload
      id={extra?.id ?? 7}
      onTitleReady={vi.fn()}
      onNavigateEntity={vi.fn()}
      onClose={extra?.onClose ?? vi.fn()}
      onDirtyChange={extra?.onDirtyChange}
    />,
  );
}

describe('<NotePayload>', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockUpdate.mockReset();
    mockDelete.mockReset();
    mockInput.mockReset();
    mockPromote.mockReset();
    confirmMock.mockReset();
    pushMock.mockReset();
    refreshMock.mockReset();
    mockGet.mockResolvedValue(noteFixture);
    mockUpdate.mockResolvedValue(noteFixture);
    mockPromote.mockResolvedValue({ taskId: 42, sourceId: 99 });
    mockTranslate.mockReset();
    mockTranslate.mockResolvedValue({ contentTranslated: 'translated' });
    mockLookupEntities.mockReset();
    mockLookupEntities.mockResolvedValue({});
    mockLocale.current = 'zh';
  });

  afterEach(() => {
    cleanup();
    if (originalNotification === undefined) {
      Reflect.deleteProperty(window, 'Notification');
    } else {
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: originalNotification,
      });
    }
  });

  it('renders content + tags + linkedEntities after fetch', async () => {
    renderPayload();
    await waitFor(() => expect(screen.getByDisplayValue('orig')).toBeInTheDocument());
    expect(screen.getByText('t1')).toBeInTheDocument();
    expect(screen.getByText('t2')).toBeInTheDocument();
    // linkedEntity chip uses the entity name as the button label.
    expect(screen.getByRole('button', { name: 'E1' })).toBeInTheDocument();
    // linkedSource list uses title.
    expect(screen.getByRole('button', { name: 'S1' })).toBeInTheDocument();
  });

  it('renders user-source preview when a linked source has no title or URL', async () => {
    mockGet.mockResolvedValueOnce({
      ...noteFixture,
      linkedSources: [
        {
          id: 12,
          relation: 'derived_from' as const,
          title: null,
          originalUrl: null,
          rawContentPreview: 'promoted source preview',
        },
      ],
    });
    renderPayload();
    await waitFor(() => expect(screen.getByDisplayValue('orig')).toBeInTheDocument());
    expect(
      screen.getByRole('button', {
        name: 'library.source_preview_quoted(snippet=promoted source preview)',
      }),
    ).toBeInTheDocument();
  });

  it('toggles pinned with single click (optimistic + PATCH)', async () => {
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, pinned: true });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    // Pin button is i18n-routed → label = `note_payload.action_pin`.
    const pinBtn = screen.getByRole('button', { name: /note_payload\.action_pin/ });
    await userEvent.click(pinBtn);
    expect(mockUpdate).toHaveBeenCalledWith(7, { pinned: true });
  });

  it('content edit + Save calls updateNote', async () => {
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'updated');
    const saveBtn = screen.getByRole('button', { name: /note_payload\.action_save$/ });
    await userEvent.click(saveBtn);
    expect(mockUpdate).toHaveBeenCalledWith(7, expect.objectContaining({ content: 'updated' }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it('delete action confirms (useConfirm dialog) and calls deleteNote', async () => {
    mockDelete.mockResolvedValue(undefined);
    confirmMock.mockResolvedValueOnce(true);
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const delBtn = screen.getByRole('button', { name: /note_payload\.action_delete/ });
    await userEvent.click(delBtn);
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(7));
    // Successful delete also asks the router to refresh so the source list reloads.
    expect(refreshMock).toHaveBeenCalled();
  });

  it('promote action confirms, calls promoteNote, closes, and navigates to task detail', async () => {
    const onClose = vi.fn();
    confirmMock.mockResolvedValueOnce(true);
    mockGet.mockResolvedValueOnce({ ...noteFixture, content: promotableContent });
    renderPayload({ onClose });
    await waitFor(() => screen.getByDisplayValue(promotableContent));
    const promoteBtn = screen.getByRole('button', {
      name: /note_payload\.action_promote_to_source/,
    });
    await userEvent.click(promoteBtn);

    await waitFor(() => expect(mockPromote).toHaveBeenCalledWith(7));
    expect(onClose).toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith('/tasks/42');
  });

  it('disables promote while saved content is below the promotion minimum', async () => {
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const promoteBtn = screen.getByRole('button', {
      name: /note_payload\.action_promote_to_source/,
    });

    expect(promoteBtn).toBeDisabled();
    expect(promoteBtn).toHaveAttribute('title', 'note_payload.promote_too_short(min=600)');
    expect(mockPromote).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('surfaces note_too_short promote failures with the minimum-length hint', async () => {
    confirmMock.mockResolvedValueOnce(true);
    mockGet.mockResolvedValueOnce({ ...noteFixture, content: promotableContent });
    mockPromote.mockRejectedValueOnce(new GoldpanApiError('too short', 'note_too_short', 400));
    renderPayload();
    await waitFor(() => screen.getByDisplayValue(promotableContent));
    await userEvent.click(
      screen.getByRole('button', {
        name: /note_payload\.action_promote_to_source/,
      }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'note_payload.promote_too_short(min=600)',
    );
  });

  it('disables promote while content is dirty so stale persisted content is not submitted', async () => {
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.type(textarea, '!');
    const promoteBtn = screen.getByRole('button', {
      name: /note_payload\.action_promote_to_source/,
    });

    expect(promoteBtn).toBeDisabled();
    expect(promoteBtn).toHaveAttribute('title', 'note_payload.action_blocked_dirty');
    expect(mockPromote).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  // C3 — reclassify dispatch must thread conversationId + sessionKey so the
  // server /input route lands in the user's chat conversation rather than a
  // synthetic ephemeral one.
  it('reclassify dispatches with conversationId + sessionKey when note has a chat origin', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, conversationId: 42 });
    // archive + dispatch both succeed
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, conversationId: 42, archived: true });
    mockInput.mockResolvedValueOnce({ type: 'query', conversationId: 42 });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const reclassifyBtn = screen.getByRole('button', {
      name: /note_payload\.action_reclassify/,
    });
    await userEvent.click(reclassifyBtn);
    const asQueryBtn = await screen.findByRole('button', {
      name: /note_payload\.reclassify_to_query/,
    });
    await userEvent.click(asQueryBtn);
    await waitFor(() => expect(mockInput).toHaveBeenCalled());
    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'orig',
        forcedIntent: 'query',
        conversationId: 42,
        sessionKey: 'web:default',
      }),
    );
  });

  // I7 — when the textarea is dirty, [重新分类] must be disabled so the user
  // doesn't dispatch new content while the original note still has the old
  // content stored.
  it('disables [重新分类] while content is dirty (unsaved edits)', async () => {
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.type(textarea, '!');
    const reclassifyBtn = screen.getByRole('button', {
      name: /note_payload\.action_reclassify/,
    });
    expect(reclassifyBtn).toBeDisabled();
    expect(reclassifyBtn).toHaveAttribute('title', 'note_payload.reclassify_blocked_dirty');
  });

  // C4 — applyImmediatePatch must translate the wire `linkedEntityIds`
  // shape into the rendered `linkedEntities` array so chip removal reflects
  // immediately (before PATCH round-trip). Without the translation, removing
  // E1 only flipped the `linkedEntityIds` field on the snapshot — `linkedEntities`
  // was untouched and the chip stayed visible until the server response.
  it('C4: removing a linkedEntity drops its chip optimistically before PATCH resolves', async () => {
    // Keep updateNote pending so we can observe pre-resolution UI state.
    let resolveUpdate: (v: unknown) => void = () => {};
    mockUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    expect(screen.getByRole('button', { name: 'E1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'E2' })).toBeInTheDocument();

    const removeE1 = screen.getByRole('button', {
      name: 'note_payload.remove_entity_aria(name=E1)',
    });
    await userEvent.click(removeE1);

    // BEFORE PATCH resolves: E1 chip already gone, E2 still there.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'E1' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'E2' })).toBeInTheDocument();
    expect(mockUpdate).toHaveBeenCalledWith(7, { linkedEntityIds: [2] });

    // Resolve with the canonical post-PATCH detail; state should remain stable.
    resolveUpdate({ ...noteFixture, linkedEntities: [{ id: 2, name: 'E2' }] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'E2' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'E1' })).not.toBeInTheDocument();
  });

  // M5 — concurrent PATCH guard: rapid double click must drop the second
  // request so a late response can't clobber state set by the click in
  // between. We pin updateNote on a pending promise so the first PATCH
  // stays in flight while the second click happens.
  it('M5: drops a second immediate PATCH while the first is in flight', async () => {
    let resolveUpdate: (v: unknown) => void = () => {};
    mockUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));

    const pinBtn = screen.getByRole('button', { name: /note_payload\.action_pin/ });
    const archiveBtn = screen.getByRole('button', {
      name: /note_payload\.action_archive/,
    });
    await userEvent.click(pinBtn); // PATCH #1: { pinned: true }
    await userEvent.click(archiveBtn); // dropped: in-flight ref blocks it

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(7, { pinned: true });
    resolveUpdate({ ...noteFixture, pinned: true });
    await waitFor(() => expect(pinBtn).not.toBeDisabled());
  });

  // I5 — archive must refresh /library (NotesSection SSR filters
  // `archived: false`) and close the inspector (archived note shouldn't stay
  // mounted).
  it('I5: archiving calls router.refresh() + onClose()', async () => {
    const onClose = vi.fn();
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, archived: true });
    renderPayload({ onClose });
    await waitFor(() => screen.getByDisplayValue('orig'));
    const archiveBtn = screen.getByRole('button', {
      name: /note_payload\.action_archive/,
    });
    await userEvent.click(archiveBtn);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(7, { archived: true }));
    expect(refreshMock).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  // TG3 — tag input Enter handler: trim + lowercase + dedup are the
  // submitTagInput contract. Three flows in one test by re-using the input.
  it('TG3a: pressing Enter on a new tag dispatches updateNote with appended tag', async () => {
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    mockUpdate.mockReset(); // clear initial GET-driven setOverride writes
    mockUpdate.mockResolvedValueOnce({
      ...noteFixture,
      tags: ['t1', 't2', 'newtag'],
    });
    const input = screen.getByPlaceholderText('note_payload.add_tag_placeholder');
    await userEvent.type(input, 'newtag{Enter}');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(7, { tags: ['t1', 't2', 'newtag'] });
  });

  it('TG3b: pressing Enter on an existing tag is a no-op (dedup, no PATCH)', async () => {
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    mockUpdate.mockReset();
    const input = screen.getByPlaceholderText('note_payload.add_tag_placeholder');
    // `t1` is already in the fixture tags
    await userEvent.type(input, 't1{Enter}');
    expect(mockUpdate).not.toHaveBeenCalled();
    // Input cleared regardless so the user sees the dedup feedback.
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('TG3c: leading/trailing whitespace + uppercase get trimmed + lowercased before PATCH', async () => {
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    mockUpdate.mockReset();
    mockUpdate.mockResolvedValueOnce({
      ...noteFixture,
      tags: ['t1', 't2', 'foo'],
    });
    const input = screen.getByPlaceholderText('note_payload.add_tag_placeholder');
    await userEvent.type(input, '  FOO  {Enter}');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // tag normalized to lowercase + trimmed
    expect(mockUpdate).toHaveBeenCalledWith(7, { tags: ['t1', 't2', 'foo'] });
  });

  // Batch 7 thread #6 — textarea must be disabled while Save is in flight.
  // Otherwise: user types A → clicks Save (pending) → types B → response
  // handler `setDirtyContent(null)` wipes B silently.
  it('thread #6: disables textarea while savingPatch is in flight', async () => {
    let resolveUpdate: (v: unknown) => void = () => {};
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    // First make the textarea dirty so the Save button shows up.
    await userEvent.type(textarea, '!');
    mockUpdate.mockReset();
    mockUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const saveBtn = screen.getByRole('button', { name: /note_payload\.action_save$/ });
    await userEvent.click(saveBtn);
    // While the PATCH is pending the textarea must be disabled — typing into
    // it now would otherwise produce a value the response handler discards.
    expect(textarea).toBeDisabled();
    resolveUpdate({ ...noteFixture, content: 'orig!' });
    await waitFor(() => expect(textarea).not.toBeDisabled());
  });

  // Batch 7 thread #5 — once the reclassify modal is open, its 4 chip buttons
  // must also be disabled while the dispatch is in flight. The outer trigger
  // is already gated by isReclassifying, but double-clicking a chip or
  // clicking two chips in succession previously archived the same note twice
  // and POSTed /input multiple times.
  it('thread #5: disables ReclassifyModal chip buttons while reclassify is in flight', async () => {
    let resolveInput: (v: unknown) => void = () => {};
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, archived: true });
    mockInput.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInput = resolve;
        }),
    );
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const reclassifyBtn = screen.getByRole('button', {
      name: /note_payload\.action_reclassify/,
    });
    await userEvent.click(reclassifyBtn);
    const asQueryBtn = await screen.findByRole('button', {
      name: /note_payload\.reclassify_to_query/,
    });
    await userEvent.click(asQueryBtn);
    // After the dispatch starts (mockInput pending), all 4 modal buttons
    // must be disabled — second click on any of them is a no-op.
    await waitFor(() => expect(asQueryBtn).toBeDisabled());
    expect(
      screen.getByRole('button', { name: /note_payload\.reclassify_to_submit/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /note_payload\.reclassify_to_tracking/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /note_payload\.reclassify_keep_note/ }),
    ).toBeDisabled();
    // Double click should not dispatch /input twice.
    await userEvent.click(asQueryBtn);
    expect(mockInput).toHaveBeenCalledTimes(1);
    resolveInput({ type: 'query', conversationId: null });
  });

  // I6 — content dirty must propagate to onDirtyChange so the Inspector shell
  // can run its close-confirm guard (same mechanism as InterestPayload).
  it('I6: invokes onDirtyChange(true) on textarea edit, (false) on clear', async () => {
    const onDirtyChange = vi.fn();
    renderPayload({ onDirtyChange });
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    // First render fires onDirtyChange(false) via the effect; clear the spy
    // so the assertion focuses on the transition triggered by editing.
    onDirtyChange.mockClear();
    await userEvent.type(textarea, '!');
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
    // Cancel the edit → dirty back to false.
    const cancelBtn = screen.getByRole('button', { name: /common\.cancel/ });
    await userEvent.click(cancelBtn);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  // T3 (F-SRC-MSG-LINK-NO-TEST): when a note carries `sourceMessageId` +
  // `conversationId`, the inspector renders a "View conversation on …" link
  // routed to `/?c=<convId>`. Without this regression, removing the link
  // wouldn't surface in CI — chat-origin notes are the only path users have
  // back to their source conversation.
  it('T3: renders sourceMessage link with ?c= query param when conversationId+sourceMessageId present', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, sourceMessageId: 99, conversationId: 7 });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/?c=7');
  });

  it('blocks sourceMessage navigation while content is dirty', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, sourceMessageId: 99, conversationId: 7 });
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.type(textarea, '!');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(fireEvent.click(link)).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('note_payload.navigation_blocked_dirty');
  });

  // T6 (F-RECLASSIFY-CURRCONTENT-NO-TEST): when the user edits content + Save
  // before reclassifying, the dispatch must carry the *saved* content (override
  // path), not the original fixture value. Without this regression, dispatch
  // could fall back to the stale `state.data.content` and lose the edit.
  it('T6: reclassify dispatches saved content (override path) after content edit + Save', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, content: 'orig' });
    // Save returns updated content
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, content: 'updated' });
    // archive succeeds; mockInput captures the dispatched body
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, content: 'updated', archived: true });
    mockInput.mockResolvedValueOnce({ type: 'query', conversationId: null });
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'updated');
    const saveBtn = screen.getByRole('button', { name: /note_payload\.action_save$/ });
    await userEvent.click(saveBtn);
    await waitFor(() => expect(screen.getByDisplayValue('updated')).toBeInTheDocument());

    const reclassifyBtn = screen.getByRole('button', {
      name: /note_payload\.action_reclassify/,
    });
    await userEvent.click(reclassifyBtn);
    const asQueryBtn = await screen.findByRole('button', {
      name: /note_payload\.reclassify_to_query/,
    });
    await userEvent.click(asQueryBtn);
    await waitFor(() => expect(mockInput).toHaveBeenCalled());
    expect(mockInput).toHaveBeenCalledWith(expect.objectContaining({ input: 'updated' }));
  });

  // T4 (F-RECLASSIFY-NAV-NO-TEST): reclassify success → close modal +
  // onClose + router.push(/?c=<convId>). Without this regression a navigation
  // regression would only surface in manual QA.
  it('T4: reclassify success closes modal + onClose + router.push(/?c=<convId>)', async () => {
    const onClose = vi.fn();
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, archived: true });
    mockInput.mockResolvedValueOnce({ type: 'query', conversationId: 7 });
    renderPayload({ onClose });
    await waitFor(() => screen.getByDisplayValue('orig'));
    const reclassifyBtn = screen.getByRole('button', {
      name: /note_payload\.action_reclassify/,
    });
    await userEvent.click(reclassifyBtn);
    const asQueryBtn = await screen.findByRole('button', {
      name: /note_payload\.reclassify_to_query/,
    });
    await userEvent.click(asQueryBtn);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/?c=7'));
    expect(onClose).toHaveBeenCalled();
    // Modal closed → keep-note button (only mounted while modal open) gone.
    expect(screen.queryByRole('button', { name: /note_payload\.reclassify_keep_note/ })).toBeNull();
  });

  it('T4-fallback: reclassify success without dispatched conversationId navigates to /', async () => {
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, archived: true });
    // Omit conversationId entirely so the cast `{ conversationId?: number }`
    // reads `undefined` and the navigation falls back to `/`.
    mockInput.mockResolvedValueOnce({
      type: 'submit',
      status: 'accepted',
      taskId: 1,
      warnings: [],
    });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const reclassifyBtn = screen.getByRole('button', {
      name: /note_payload\.action_reclassify/,
    });
    await userEvent.click(reclassifyBtn);
    const asSubmitBtn = await screen.findByRole('button', {
      name: /note_payload\.reclassify_to_submit/,
    });
    await userEvent.click(asSubmitBtn);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/'));
  });

  it('T4-fallback-session: reclassify fallback carries notice flag into chat URL', async () => {
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, archived: true });
    let callIdx = 0;
    mockInput.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return Promise.reject(new GoldpanApiError('archived', 'conversation_archived', 409));
      }
      return Promise.resolve({ type: 'query', conversationId: 9 });
    });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const reclassifyBtn = screen.getByRole('button', {
      name: /note_payload\.action_reclassify/,
    });
    await userEvent.click(reclassifyBtn);
    const asQueryBtn = await screen.findByRole('button', {
      name: /note_payload\.reclassify_to_query/,
    });
    await userEvent.click(asQueryBtn);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/?c=9&reclassifyFallback=1'));
  });

  // T5 (F-ROLLBACK-BANNER-NO-TEST): when archive succeeds + dispatch fails +
  // unarchive rollback also fails, the inspector must surface
  // `reclassify_rollback_failed` (not the generic dispatch error). Pin the
  // archive PATCH to succeed, then make `input` reject, then make the rollback
  // unarchive PATCH also reject.
  it('T5: shows reclassify_rollback_failed banner when archive succeeds + dispatch fails + unarchive fails', async () => {
    mockUpdate
      .mockResolvedValueOnce({ ...noteFixture, archived: true }) // archive ok
      .mockRejectedValueOnce(new Error('rollback boom')); // unarchive fails
    mockInput.mockRejectedValueOnce(new Error('dispatch boom'));
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const reclassifyBtn = screen.getByRole('button', {
      name: /note_payload\.action_reclassify/,
    });
    await userEvent.click(reclassifyBtn);
    const asQueryBtn = await screen.findByRole('button', {
      name: /note_payload\.reclassify_to_query/,
    });
    await userEvent.click(asQueryBtn);
    // The error banner uses reclassify_rollback_failed with the *original*
    // dispatch error interpolated as {error} — our test mock prints the key
    // + params so we assert on the key prefix.
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/note_payload\.reclassify_rollback_failed/);
    expect(banner.textContent).toMatch(/dispatch boom/);
    expect(screen.queryByRole('button', { name: /note_payload\.reclassify_keep_note/ })).toBeNull();
  });

  it('closes reclassify modal before showing dispatch failure banner', async () => {
    mockUpdate
      .mockResolvedValueOnce({ ...noteFixture, archived: true })
      .mockResolvedValueOnce({ ...noteFixture, archived: false });
    mockInput.mockRejectedValueOnce(new Error('dispatch boom'));
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const reclassifyBtn = screen.getByRole('button', {
      name: /note_payload\.action_reclassify/,
    });
    await userEvent.click(reclassifyBtn);
    const asQueryBtn = await screen.findByRole('button', {
      name: /note_payload\.reclassify_to_query/,
    });
    await userEvent.click(asQueryBtn);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/dispatch boom/);
    expect(screen.queryByRole('button', { name: /note_payload\.reclassify_keep_note/ })).toBeNull();
  });

  // T16 (F-DELETE-FAIL-NO-TEST): delete failure surfaces a delete-specific
  // banner so the user can retry instead of being silently dropped.
  it('T16: shows delete_failed banner when deleteNote rejects', async () => {
    confirmMock.mockResolvedValueOnce(true);
    mockDelete.mockRejectedValueOnce(new Error('server down'));
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const delBtn = screen.getByRole('button', { name: /note_payload\.action_delete/ });
    await userEvent.click(delBtn);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/note_payload\.delete_failed/);
  });

  // T17 (F-DELETE-CANCEL-NO-TEST): if the confirm dialog returns false the
  // delete must NOT fire — important because confirm() is the only barrier
  // between an accidental click and a permanent delete.
  it('T17: does not call deleteNote when confirm returns false', async () => {
    confirmMock.mockResolvedValueOnce(false);
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const delBtn = screen.getByRole('button', { name: /note_payload\.action_delete/ });
    await userEvent.click(delBtn);
    // Wait a tick for any spurious promise to resolve before asserting.
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(mockDelete).not.toHaveBeenCalled();
  });

  // T18 (F-TAG-ONBLUR-NO-TEST): tag input commits on blur — but only when
  // focus actually leaves the tags section. Moving focus to a ✕ remove
  // button inside the same section used to double-fire (race-prevention).
  it('T18a: submits tag on blur (focus leaves tags section)', async () => {
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    mockUpdate.mockReset();
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, tags: ['t1', 't2', 'newtag'] });
    const input = screen.getByPlaceholderText('note_payload.add_tag_placeholder');
    await userEvent.type(input, 'newtag');
    // Blur to a non-tags-section element (the textarea is in a sibling section).
    const textarea = screen.getByDisplayValue('orig');
    textarea.focus();
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith(7, { tags: ['t1', 't2', 'newtag'] });
  });

  it('T18b: does NOT submit tag on blur when focus moves to ✕ within same section', async () => {
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    mockUpdate.mockReset();
    const input = screen.getByPlaceholderText('note_payload.add_tag_placeholder');
    await userEvent.type(input, 'newtag');
    // Focus the ✕ remove button for t1 — same tags-section, so blur should
    // bail out and *not* commit "newtag" as a separate PATCH.
    const removeT1 = screen.getByRole('button', {
      name: 'note_payload.remove_tag_aria(tag=t1)',
    });
    removeT1.focus();
    // Give blur a tick — if the race regressed, mockUpdate would now hold a
    // tag-append call. Asserting strict 0 calls catches both the spurious
    // append AND any drift in submitTagInput's no-op path.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // T19 (F-PATCH-FAIL-ROLLBACK-NO-TEST): when an immediate PATCH (subtype
  // change here) fails, the chip change must roll back to the pre-PATCH
  // snapshot AND the user must see the `update_failed` banner.
  it('T19: rolls back optimistic chip change + shows update_failed when subtype PATCH rejects', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, subtype: 'note' });
    mockUpdate.mockRejectedValueOnce(new Error('server boom'));
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    // Click memo chip — optimistic flip then revert on rejection.
    const memoChip = screen.getByRole('button', { name: 'library.notes_subtype_memo' });
    await userEvent.click(memoChip);
    // Wait for failure path to settle then assert the `note` chip is active again.
    const noteChip = screen.getByRole('button', { name: 'library.notes_subtype_note' });
    await waitFor(() => expect(noteChip).toHaveAttribute('aria-pressed', 'true'));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/note_payload\.update_failed/);
  });

  // F-ARCHIVE-DELETE-BYPASS-DIRTY: archive button must be disabled while
  // content is dirty so the user can't accidentally archive a draft.
  it('archive button disabled when content is dirty', async () => {
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.type(textarea, '!');
    const archiveBtn = screen.getByRole('button', {
      name: /note_payload\.action_archive/,
    });
    expect(archiveBtn).toBeDisabled();
  });

  it('delete button disabled when content is dirty', async () => {
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.type(textarea, '!');
    const delBtn = screen.getByRole('button', { name: /note_payload\.action_delete/ });
    expect(delBtn).toBeDisabled();
  });

  // F-MODAL-DOM-MISMATCH + inline #5: backdrop button must also disable
  // while dispatch is in flight so clicking the backdrop can't expose the
  // editor underneath mid-archive.
  it('modal backdrop button is disabled during isReclassifying', async () => {
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, archived: true });
    let resolveInput: (v: unknown) => void = () => {};
    mockInput.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInput = resolve;
        }),
    );
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const reclassifyBtn = screen.getByRole('button', {
      name: /note_payload\.action_reclassify/,
    });
    await userEvent.click(reclassifyBtn);
    const asQueryBtn = await screen.findByRole('button', {
      name: /note_payload\.reclassify_to_query/,
    });
    await userEvent.click(asQueryBtn);
    const backdropBtn = screen.getByRole('button', {
      name: /note_payload\.reclassify_dismiss/,
    });
    await waitFor(() => expect(backdropBtn).toBeDisabled());
    resolveInput({ type: 'query', conversationId: null });
  });

  // F-TEXTAREA-OVER-DISABLE: pin/archive immediate PATCH must NOT freeze the
  // textarea. Only contentSaveInFlight (set during handleSave) gates it.
  it('textarea NOT disabled during pin/archive immediate PATCH', async () => {
    let resolveUpdate: (v: unknown) => void = () => {};
    mockUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    const pinBtn = screen.getByRole('button', { name: /note_payload\.action_pin/ });
    await userEvent.click(pinBtn);
    // PATCH is pending; textarea must STILL be enabled — earlier regression
    // had `disabled={savingPatch}` which froze the editor.
    expect(textarea).not.toBeDisabled();
    resolveUpdate({ ...noteFixture, pinned: true });
    await waitFor(() => expect(pinBtn).not.toBeDisabled());
  });

  // F-NON-ARCHIVE-STALE: every immediate PATCH (not just archive) must call
  // router.refresh() so the left-side NotesSection reflects the new state.
  it('all immediate PATCHes call router.refresh()', async () => {
    // pin → refresh
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, pinned: true });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const pinBtn = screen.getByRole('button', { name: /note_payload\.action_pin/ });
    await userEvent.click(pinBtn);
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    refreshMock.mockClear();

    // subtype change → refresh
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, pinned: true, subtype: 'memo' });
    const memoChip = screen.getByRole('button', { name: 'library.notes_subtype_memo' });
    await userEvent.click(memoChip);
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    refreshMock.mockClear();

    // tag remove → refresh
    mockUpdate.mockResolvedValueOnce({
      ...noteFixture,
      pinned: true,
      subtype: 'memo',
      tags: ['t2'],
    });
    const removeT1 = screen.getByRole('button', {
      name: 'note_payload.remove_tag_aria(tag=t1)',
    });
    await userEvent.click(removeT1);
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  // F-SAVE-NO-DRAFT-HINT: handleSave failure must use the
  // `save_failed_draft_preserved` banner (not generic `update_failed`) so
  // the user knows their local edits are still in the textarea.
  it('F-SAVE-NO-DRAFT-HINT: save failure shows save_failed_draft_preserved banner (draft preserved)', async () => {
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.type(textarea, '!');
    mockUpdate.mockReset();
    mockUpdate.mockRejectedValueOnce(new Error('server boom'));
    const saveBtn = screen.getByRole('button', { name: /note_payload\.action_save$/ });
    await userEvent.click(saveBtn);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/note_payload\.save_failed_draft_preserved/);
    // Draft (orig + '!') is still visible in textarea so user can retry.
    expect((textarea as HTMLTextAreaElement).value).toBe('orig!');
  });

  // P7.2 — translate button visibility + click flow + preview rendering.
  // The button is hidden when note.language matches UI locale; click triggers
  // SDK.translateNote(id) and renders the returned text in a readonly preview
  // section below the textarea. Pre-existing translations also render even
  // when the button is hidden, so users can see prior translations after
  // switching locale.
  it('renders translate button when note language differs from UI locale', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, language: 'en' });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    expect(
      screen.getByRole('button', { name: /note_payload\.action_translate/ }),
    ).toBeInTheDocument();
  });

  it('does not render translate button when note language matches UI locale', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, language: 'zh' });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    expect(
      screen.queryByRole('button', { name: /note_payload\.action_translate/ }),
    ).not.toBeInTheDocument();
  });

  it('clicking translate calls SDK and renders preview', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, language: 'en' });
    mockTranslate.mockResolvedValueOnce({ contentTranslated: '你好' });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    const btn = screen.getByRole('button', { name: /note_payload\.action_translate/ });
    await userEvent.click(btn);
    await waitFor(() => expect(mockTranslate).toHaveBeenCalledWith(7));
    // Preview section renders the translated text below the textarea.
    expect(await screen.findByText('你好')).toBeInTheDocument();
  });

  it('shows inline error when translateNote rejects with already_target_language', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, language: 'en' });
    mockTranslate.mockRejectedValueOnce(
      new GoldpanApiError('no-op', 'already_target_language', 400),
    );
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.click(screen.getByRole('button', { name: /note_payload\.action_translate/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /note_payload\.translate_already_target/,
    );
  });

  it('shows archived inline error when translateNote rejects with note_archived', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, language: 'en' });
    mockTranslate.mockRejectedValueOnce(new GoldpanApiError('archived', 'note_archived', 400));
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.click(screen.getByRole('button', { name: /note_payload\.action_translate/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /note_payload\.translate_blocked_archived/,
    );
  });

  it('renders existing contentTranslated preview even when button hidden', async () => {
    mockGet.mockResolvedValueOnce({
      ...noteFixture,
      language: 'zh',
      contentTranslated: 'Pre-existing translation',
    });
    renderPayload();
    expect(await screen.findByText('Pre-existing translation')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /note_payload\.action_translate/ }),
    ).not.toBeInTheDocument();
  });

  it('ignores a stale translate response after switching to another note', async () => {
    let resolveTranslate: ((v: { contentTranslated: string }) => void) | undefined;
    mockGet
      .mockResolvedValueOnce({ ...noteFixture, id: 7, language: 'en' })
      .mockResolvedValueOnce({ ...noteFixture, id: 8, content: 'second', language: 'en' });
    mockTranslate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranslate = resolve;
        }),
    );
    const rendered = renderPayload({ id: 7 });
    await waitFor(() => screen.getByDisplayValue('orig'));
    await userEvent.click(screen.getByRole('button', { name: /note_payload\.action_translate/ }));
    await waitFor(() => expect(mockTranslate).toHaveBeenCalledWith(7));

    rendered.rerender(
      <NotePayload id={8} onTitleReady={vi.fn()} onNavigateEntity={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() => screen.getByDisplayValue('second'));
    await act(async () => {
      resolveTranslate?.({ contentTranslated: 'old translation' });
    });

    expect(screen.getByDisplayValue('second')).toBeInTheDocument();
    expect(screen.queryByText('old translation')).not.toBeInTheDocument();
  });

  it('hides existing translation preview while content draft is dirty', async () => {
    mockGet.mockResolvedValueOnce({
      ...noteFixture,
      language: 'en',
      contentTranslated: 'Saved translation',
    });
    renderPayload();
    const textarea = await waitFor(() => screen.getByDisplayValue('orig'));
    expect(screen.getByText('Saved translation')).toBeInTheDocument();

    await userEvent.type(textarea, '!');

    expect(screen.queryByText('Saved translation')).not.toBeInTheDocument();
  });

  it('renders mention chips for mentions that resolve to entities (excluding already linkedEntities)', async () => {
    mockGet.mockResolvedValueOnce({
      ...noteFixture,
      content: 'I read @Anthropic and @OpenAI today',
      linkedEntities: [{ id: 1, name: 'Anthropic' }], // 已显式 link
    });
    mockLookupEntities.mockResolvedValueOnce({ anthropic: 1, openai: 2 });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('I read @Anthropic and @OpenAI today'));
    // Only @OpenAI should appear as a mention chip (Anthropic already linked).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^@OpenAI$/u })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^@Anthropic$/u })).not.toBeInTheDocument();
  });

  it('renders mention chips for bracketed entity names with punctuation', async () => {
    mockGet.mockResolvedValueOnce({
      ...noteFixture,
      content: 'I used @[OpenAI, Inc.] today',
      linkedEntities: [],
    });
    mockLookupEntities.mockResolvedValueOnce({ 'openai, inc.': 42 });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('I used @[OpenAI, Inc.] today'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^@OpenAI, Inc\.$/u })).toBeInTheDocument();
    });
    expect(mockLookupEntities).toHaveBeenCalledWith(['openai, inc.'], expect.any(AbortSignal));
  });

  it('does not treat e-mail domains as mentions', async () => {
    mockGet.mockResolvedValueOnce({
      ...noteFixture,
      content: 'contact alice@openai.com for follow-up',
      linkedEntities: [],
    });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('contact alice@openai.com for follow-up'));
    expect(screen.queryByText(/note_payload\.mentioned_heading/)).not.toBeInTheDocument();
    expect(mockLookupEntities).not.toHaveBeenCalled();
  });

  it('clicking mention chip navigates inspector to entity', async () => {
    const onNavigate = vi.fn();
    mockGet.mockResolvedValueOnce({
      ...noteFixture,
      content: 'see @Claude',
      linkedEntities: [],
    });
    mockLookupEntities.mockResolvedValueOnce({ claude: 42 });
    render(
      <NotePayload id={7} onTitleReady={vi.fn()} onNavigateEntity={onNavigate} onClose={vi.fn()} />,
    );
    const chip = await screen.findByRole('button', { name: /^@Claude$/u });
    await userEvent.click(chip);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'entity', id: 42 });
  });

  it('does not render mention section when no mentions in content/translation', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, content: 'plain text no at' });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('plain text no at'));
    expect(screen.queryByText(/note_payload\.mentioned_heading/)).not.toBeInTheDocument();
    expect(mockLookupEntities).not.toHaveBeenCalled();
  });

  it('renders translation preview with mention buttons (replaces P7.2 plain text body)', async () => {
    mockGet.mockResolvedValueOnce({
      ...noteFixture,
      content: 'orig with @A',
      contentTranslated: 'translated with @A',
      language: 'en',
      linkedEntities: [{ id: 9, name: 'A' }], // explicitly link so chip row 不重复
    });
    mockLookupEntities.mockResolvedValueOnce({ a: 9 });
    mockLocale.current = 'zh';
    const { container } = renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig with @A'));
    // translation-preview body now contains @A as inline button. Scope the
    // query to the preview section so chip-row buttons (excluded here since
    // entity is already linked) can't false-positive.
    await waitFor(() => {
      const previewSection = container.querySelector('.gp-note-payload__translation-preview');
      expect(previewSection).not.toBeNull();
      const previewButton = previewSection!.querySelector('button.gp-mention');
      expect(previewButton).not.toBeNull();
      expect(previewButton?.textContent).toBe('@A');
    });
  });

  it('renders due-date input only when subtype === memo', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, subtype: 'memo' });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    expect(screen.getByLabelText(/note_payload\.due_at_label/u)).toBeInTheDocument();
  });

  it('hides due-date input for non-memo subtype', async () => {
    // 默认 note 即非 memo —— 由 noteFixture.subtype = 'note' 已覆盖，这里再次显式
    // mock 一次以保持测试可读：subtype !== 'memo' 时不应出现 dueAt 输入。
    mockGet.mockResolvedValueOnce({ ...noteFixture, subtype: 'note' });
    renderPayload();
    await waitFor(() => screen.getByDisplayValue('orig'));
    expect(screen.queryByLabelText(/note_payload\.due_at_label/u)).not.toBeInTheDocument();
  });

  it('changing due-date PATCHes dueAt', async () => {
    mockGet.mockResolvedValueOnce({ ...noteFixture, subtype: 'memo', dueAt: null });
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, subtype: 'memo', dueAt: 1_700_000_000_000 });
    renderPayload();
    const input = (await screen.findByLabelText(/note_payload\.due_at_label/u)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2024-01-01T00:00' } });
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ dueAt: expect.any(Number) }),
      );
    });
  });

  it('shows banner-only warning when notification permission was already denied', async () => {
    const requestPermission = vi.fn();
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'denied', requestPermission },
    });
    mockGet.mockResolvedValueOnce({ ...noteFixture, subtype: 'memo', dueAt: null });
    mockUpdate.mockResolvedValueOnce({ ...noteFixture, subtype: 'memo', dueAt: 1_700_000_000_000 });
    renderPayload();
    const input = (await screen.findByLabelText(/note_payload\.due_at_label/u)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2024-01-01T00:00' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'note_payload.notification_denied_banner_only',
    );
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('shows reminded_at status when both dueAt and remindedAt are set', async () => {
    mockGet.mockResolvedValueOnce({
      ...noteFixture,
      subtype: 'memo',
      dueAt: 1_700_000_000_000,
      remindedAt: 1_700_000_500_000,
    });
    renderPayload();
    expect(await screen.findByText(/note_payload\.reminded_at/u)).toBeInTheDocument();
  });
});
