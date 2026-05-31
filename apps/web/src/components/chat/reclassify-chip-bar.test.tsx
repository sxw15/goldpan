import { GoldpanApiError } from '@goldpan/web-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import zhMessages from '../../../messages/zh.json';
import { ReclassifyChipBar } from './reclassify-chip-bar';

// PR #57 thread #1 — lazy archive check fires on mount via
// `getBrowserApiClient().getNote(noteId)`. Default mock returns a
// not-archived note so existing tests are unaffected; the archived-hide
// test overrides per-call below.
const mockGetNote = vi.fn();
vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    getNote: mockGetNote,
  }),
}));

beforeEach(() => {
  mockGetNote.mockReset();
  mockGetNote.mockResolvedValue({ id: 5, archived: false });
});

// 与 clarify-chip.test.tsx 同模式 — useTranslations 必须包在 NextIntlClientProvider
// 里。喂全量 zh.json 让组件能同时拿到 `reclassify_chip_bar` 和 `library` 两个
// namespace（subtype 标签走 library.notes_subtype_<subtype>）。
function setup(props: Partial<React.ComponentProps<typeof ReclassifyChipBar>> = {}) {
  const onReclassify = vi.fn();
  const utils = render(
    <NextIntlClientProvider locale="zh" messages={zhMessages} timeZone="UTC">
      <ReclassifyChipBar
        noteId={5}
        subtype="note"
        originalContent="foo"
        onReclassify={onReclassify}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return { onReclassify, ...utils };
}

describe('ReclassifyChipBar', () => {
  it('shows current subtype label resolved against library.notes_subtype_note', () => {
    setup();
    // zh.json: reclassify_chip_bar.saved_as = "已记为 [{subtype}]"
    // library.notes_subtype_note = "笔记"
    expect(screen.getByText('已记为 [笔记]')).toBeInTheDocument();
  });

  it('clicking "改为查询" calls onReclassify with query intent + noteId + content', async () => {
    const { onReclassify } = setup();
    const chip = screen.getByRole('button', { name: '改为查询' });
    await waitFor(() => expect(chip).not.toBeDisabled());
    fireEvent.click(chip);
    expect(onReclassify).toHaveBeenCalledWith({
      noteId: 5,
      originalContent: 'foo',
      targetIntentKey: 'query',
    });
  });

  it('keeps chips disabled while the archived-state probe is in flight', () => {
    mockGetNote.mockImplementationOnce(() => new Promise(() => {}));
    const { onReclassify } = setup();
    const chip = screen.getByRole('button', { name: '改为查询' });
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(onReclassify).not.toHaveBeenCalled();
  });

  it('does nothing when originalContent is empty (chips disabled)', () => {
    const { onReclassify } = setup({ originalContent: '' });
    fireEvent.click(screen.getByRole('button', { name: '改为查询' }));
    expect(onReclassify).not.toHaveBeenCalled();
  });

  // TG5 — disabled prop guard: chat-view passes `disabled={isReclassifying}`
  // so a click during an in-flight reclassify (archive PATCH + /input dispatch
  // can take seconds) doesn't queue a second dispatch. Native `disabled` covers
  // the visual disable; the handler-side guard mirrors it for defense vs
  // synthetic clicks (programmatic dispatch, automated tests, etc.).
  it('TG5: click is a no-op when disabled={true}', () => {
    const { onReclassify } = setup({ disabled: true });
    fireEvent.click(screen.getByRole('button', { name: '改为查询' }));
    expect(onReclassify).not.toHaveBeenCalled();
  });

  // PR #57 thread #1: cross-page stale ChipBar — user archives a note in
  // /library inspector then comes back to chat where the persisted note
  // bubble still renders ChipBar (chat-view's per-session
  // `reclassifiedNoteIds` is empty for this path). Lazy GET on mount sees
  // `archived: true` and swaps to the `chat.reclassified_note` hint
  // instead, matching the in-session reclassified UX.
  it('thread #1: hides chips + shows reclassified hint when note is already archived (cross-page case)', async () => {
    mockGetNote.mockResolvedValueOnce({ id: 5, archived: true });
    setup();
    await waitFor(() => {
      expect(screen.getByTestId('reclassify-chip-bar-archived')).toBeInTheDocument();
    });
    // zh.json: chat.reclassified_note = "已重新分类"
    expect(screen.getByText('已重新分类')).toBeInTheDocument();
    // Chips should be gone — query, not getByRole (which would throw).
    expect(screen.queryByRole('button', { name: '改为查询' })).not.toBeInTheDocument();
  });

  // T15 — unmount race: the lazy archive probe resolves AFTER the consumer
  // unmounts. The `cancelled` flag must keep `setHiddenByArchive(true)` from
  // firing on a stale component instance (React 18+ silently ignores setState
  // post-unmount, but we still don't want to mask a real bug — assert via
  // console.error spy that no warning surfaces).
  it('T15: does not setHiddenByArchive after unmount even if archived=true resolves late', async () => {
    let resolveProbe: ((v: { id: number; archived: boolean }) => void) | undefined;
    mockGetNote.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveProbe = res;
        }),
    );
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = setup();
    unmount();
    // Resolve probe AFTER unmount — `cancelled` flag must short-circuit.
    resolveProbe?.({ id: 5, archived: true });
    // Flush microtasks so the .then() handler runs.
    await Promise.resolve();
    await Promise.resolve();
    // No React state-update-on-unmounted-component warnings logged.
    expect(consoleErrSpy).not.toHaveBeenCalled();
    consoleErrSpy.mockRestore();
  });

  // T20 — F-CHIPBAR-SILENT-404 discrimination:
  // (a) 404 / 410 (note deleted) → hide chip bar so user can't archive-PATCH
  //     a guaranteed-404 endpoint.
  // (b) any other rejection → keep chips visible (transient server fault)
  //     and log with context for debuggability.
  it('T20: hides chip bar when getNote rejects with 404', async () => {
    mockGetNote.mockRejectedValueOnce(new GoldpanApiError('gone', 'not_found', 404));
    setup();
    await waitFor(() => {
      expect(screen.getByTestId('reclassify-chip-bar-archived')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: '改为查询' })).not.toBeInTheDocument();
  });

  it('T20: hides chip bar when getNote rejects with 410', async () => {
    mockGetNote.mockRejectedValueOnce(new GoldpanApiError('gone', 'gone', 410));
    setup();
    await waitFor(() => {
      expect(screen.getByTestId('reclassify-chip-bar-archived')).toBeInTheDocument();
    });
  });

  it('T20: keeps chips visible + logs when getNote rejects with non-404 error', async () => {
    const otherErr = new GoldpanApiError('boom', 'internal_error', 500);
    mockGetNote.mockRejectedValueOnce(otherErr);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setup();
    // Wait one microtask cycle so the rejection handler has a chance to run.
    await waitFor(() => {
      expect(consoleErrSpy).toHaveBeenCalledWith(
        '[ReclassifyChipBar] note state probe failed',
        expect.objectContaining({ noteId: 5, err: otherErr }),
      );
    });
    // Chips still rendered.
    expect(screen.getByRole('button', { name: '改为查询' })).toBeInTheDocument();
    expect(screen.queryByTestId('reclassify-chip-bar-archived')).not.toBeInTheDocument();
    consoleErrSpy.mockRestore();
  });

  it('T20: keeps chips visible when probe rejects with non-API plain Error', async () => {
    const plainErr = new Error('network down');
    mockGetNote.mockRejectedValueOnce(plainErr);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setup();
    await waitFor(() => {
      expect(consoleErrSpy).toHaveBeenCalled();
    });
    // Plain Error is treated like "other" — chips visible.
    expect(screen.getByRole('button', { name: '改为查询' })).toBeInTheDocument();
    consoleErrSpy.mockRestore();
  });
});
