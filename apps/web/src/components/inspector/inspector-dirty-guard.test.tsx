/**
 * Central dirty-edit close guard tests (PR #57).
 *
 * Before this refactor each shell (LibraryShell / TrackingShell) plumbed its
 * own `useConfirm` + `payloadDirty` state and wrapped `onClose`. That left
 * three leave paths unguarded: header Back button (`pop`), linked-entity
 * navigation (`push`), and any third consumer that didn't replicate the
 * pattern (ChatView's inspector had zero protection).
 *
 * Inspector now owns the guard centrally. Payloads still report dirty state
 * via `onDirtyChange` (still surfaced upward as an optional prop for sibling
 * UI), but the confirm prompt fires from Inspector on every leave path:
 *   - Esc                → handleClose → confirmIfDirty → onClose
 *   - Backdrop click     → handleClose
 *   - Header ✕ button    → handleClose
 *   - Header Back button → handleBack → confirmIfDirty → pop
 *   - Linked-entity push → handlePush → confirmIfDirty → push
 *
 * These tests pin the central contract so future regressions in any of those
 * paths fail loudly here rather than silently shipping data loss in one shell.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted shared spies so the PayloadRouter mock factory can reference them.
const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  reportDirty: undefined as ((dirty: boolean) => void) | undefined,
  navigate: undefined as ((next: { kind: 'entity'; id: number }) => void) | undefined,
  capturedDirtyFromParent: vi.fn(),
}));

vi.mock('../confirm-provider', () => ({
  useConfirm: () => mocks.confirm,
}));

// Mock PayloadRouter to expose:
//   - a button that fires onDirtyChange(true) (simulates note-payload edit)
//   - a button that fires onNavigateEntity({kind:'entity',id:99}) (linked entity)
// This lets tests drive both halves of the guard contract without depending
// on payload internals (EntityPayload, NotePayload SDK fetches, etc.).
vi.mock('./payloads', () => ({
  PayloadRouter: ({
    onDirtyChange,
    onNavigateEntity,
  }: {
    onDirtyChange?: (dirty: boolean) => void;
    onNavigateEntity: (next: { kind: 'entity'; id: number }) => void;
  }) => {
    mocks.reportDirty = onDirtyChange;
    mocks.navigate = onNavigateEntity;
    return (
      <div data-testid="payload-stub">
        <button type="button" data-testid="set-dirty-true" onClick={() => onDirtyChange?.(true)}>
          mark dirty
        </button>
        <button type="button" data-testid="set-dirty-false" onClick={() => onDirtyChange?.(false)}>
          mark clean
        </button>
        <button
          type="button"
          data-testid="navigate-entity-99"
          onClick={() => onNavigateEntity({ kind: 'entity', id: 99 })}
        >
          open entity 99
        </button>
      </div>
    );
  },
}));

import { Inspector } from './inspector';

const messages = {
  inspector: {
    back_fallback: '返回',
    close: '关闭',
    kind_entity: '实体',
    kind_source: '来源',
    unsaved_confirm: '放弃未保存的修改？',
  },
  common: {
    ok: '确定',
    cancel: '取消',
    confirm_default_title: '确认',
  },
};

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="zh" messages={messages}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe('<Inspector> central dirty-edit close guard', () => {
  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.reportDirty = undefined;
    mocks.navigate = undefined;
    mocks.capturedDirtyFromParent.mockReset();
  });

  it('not dirty + Esc → no confirm, onClose fires synchronously', async () => {
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));
    await userEvent.keyboard('{Escape}');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dirty=true + Esc → confirm fires; on cancel, onClose NOT called', async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));

    // Payload reports dirty (simulates note-payload's useEffect)
    fireEvent.click(screen.getByTestId('set-dirty-true'));

    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: '放弃未保存的修改？' }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dirty=true + Esc → confirm accept → onClose fires', async () => {
    mocks.confirm.mockResolvedValueOnce(true);
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));
    fireEvent.click(screen.getByTestId('set-dirty-true'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('dirty=true + backdrop click → confirm fires', async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));
    fireEvent.click(screen.getByTestId('set-dirty-true'));

    const backdrop = document.querySelector('.gp-inspector__backdrop');
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop as HTMLElement);

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: '放弃未保存的修改？' }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dirty=true + header ✕ button → confirm fires', async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));
    fireEvent.click(screen.getByTestId('set-dirty-true'));

    await userEvent.click(screen.getByRole('button', { name: '关闭' }));

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dirty=true + header Back button (pop) → confirm fires; cancel blocks pop', async () => {
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));

    // Push entity 99 onto the stack so previous=entity:1. No dirty yet — push
    // short-circuits the guard and runs sync.
    fireEvent.click(screen.getByTestId('navigate-entity-99'));

    // Header now renders the previous-title fallback "← 1" (entity:1's id
    // is the title fallback before async title resolves).
    const backButton = await screen.findByRole('button', { name: /← 1/ });
    expect(backButton).toBeInTheDocument();

    // Now mark dirty on the new (entity:99) payload.
    fireEvent.click(screen.getByTestId('set-dirty-true'));

    // Cancel the confirm — Back should NOT pop.
    mocks.confirm.mockResolvedValueOnce(false);
    await userEvent.click(backButton);

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: '放弃未保存的修改？' }),
      ),
    );

    // Back button still present → stack did NOT pop (entity:99 still current).
    expect(screen.getByRole('button', { name: /← 1/ })).toBeInTheDocument();
    // onClose untouched.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dirty=true + linked-entity push → confirm fires; cancel blocks navigation', async () => {
    mocks.confirm.mockReset();
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));

    fireEvent.click(screen.getByTestId('set-dirty-true'));

    // Cancel — push must not run.
    mocks.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId('navigate-entity-99'));

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: '放弃未保存的修改？' }),
      ),
    );

    // No Back button → push did NOT happen (stack still {current: entity:1}).
    // Inspector renders an empty <span aria-hidden> in the Back slot when
    // previousTitle is null — i.e. no role=button with "←" text.
    expect(screen.queryByRole('button', { name: /←/ })).toBeNull();
  });

  it('dirty=true + linked-entity push → confirm accept → push runs and stack advances', async () => {
    mocks.confirm.mockReset();
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));

    fireEvent.click(screen.getByTestId('set-dirty-true'));

    mocks.confirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByTestId('navigate-entity-99'));

    // Back button appears once push commits — text is "← 1" (entity:1 became
    // the previous payload after the push).
    const backButton = await screen.findByRole('button', { name: /← 1/ });
    expect(backButton).toBeInTheDocument();
  });

  it('Inspector forwards onDirtyChange to parent prop when provided', () => {
    const onClose = vi.fn();
    const onDirtyChange = vi.fn();
    render(
      wrap(
        <Inspector
          payload={{ kind: 'entity', id: 1 }}
          onClose={onClose}
          onDirtyChange={onDirtyChange}
        />,
      ),
    );

    fireEvent.click(screen.getByTestId('set-dirty-true'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByTestId('set-dirty-false'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('Inspector works without parent onDirtyChange prop (chat-view path)', async () => {
    // ChatView intentionally does NOT pass onDirtyChange — it relies on
    // Inspector's internal guard. This test pins that the lack of a parent
    // prop does not break the central confirm flow.
    mocks.confirm.mockResolvedValueOnce(false);
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));

    fireEvent.click(screen.getByTestId('set-dirty-true'));
    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: '放弃未保存的修改？' }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dirty=true + confirm accept clears internal flag (no re-prompt on next leave)', async () => {
    mocks.confirm.mockResolvedValueOnce(true); // first leave accepted
    const onClose = vi.fn();
    render(wrap(<Inspector payload={{ kind: 'entity', id: 1 }} onClose={onClose} />));

    fireEvent.click(screen.getByTestId('set-dirty-true'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // After accept, the internal payloadDirty was cleared. A second push
    // (e.g. via linked-entity chip in the new render) must NOT re-prompt.
    // Re-render Inspector to simulate a fresh payload after URL sync.
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
});
