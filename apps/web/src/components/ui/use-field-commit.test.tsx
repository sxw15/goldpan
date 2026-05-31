import { act, renderHook, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVED_TIMEOUT_MS, useEditableCommit, useToggleCommit } from './use-field-commit';

// Minimal messages stub — only what FieldStatus reads.
const messages = {
  settings: {
    field_status: {
      saving: 'Saving',
      saved: 'Saved',
      pending_restart: 'Saved · restart to take effect',
      pending_restart_shadowed: 'Saved · restart · .env diverged',
      error: 'Save failed: {message}',
      saving_aria: 'Saving {field}',
      saved_aria: 'Saved {field}',
      pending_restart_aria: 'Saved {field}',
      error_aria: '{field} failed: {message}',
    },
  },
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    {children}
  </NextIntlClientProvider>
);

// StrictMode wrapper for regression tests against dev double-mount.
// React 18+ StrictMode in development runs effect setup → cleanup → setup
// once on mount, which exposes refs that aren't restored in setup.
const strictWrapper = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    <StrictMode>{children}</StrictMode>
  </NextIntlClientProvider>
);

beforeEach(() => {
  // shouldAdvanceTime lets waitFor's polling observe state transitions
  // triggered by fake-timer callbacks. Without it, the saved → pristine
  // test deadlocks because waitFor needs real-clock ticks to re-render.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useToggleCommit', () => {
  it('starts in pristine state with current === committed', () => {
    const commit = vi.fn();
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper },
    );
    expect(result.current.state).toBe('pristine');
    expect(result.current.error).toBeNull();
    expect(result.current.current).toBe('false');
  });

  it('fire optimistically updates current then commits → saved → pristine', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      updatedItems: [],
      pendingRestartKeys: [],
    });
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper },
    );

    await act(async () => {
      await result.current.fire('true');
    });

    expect(commit).toHaveBeenCalledWith({ K: 'true' });
    expect(result.current.state).toBe('saved');
    expect(result.current.current).toBe('true'); // optimistic stays

    await act(async () => {
      vi.advanceTimersByTime(SAVED_TIMEOUT_MS + 100);
    });
    await waitFor(() => expect(result.current.state).toBe('pristine'));
  });

  it('routes to pending-restart when key in pendingRestartKeys', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      updatedItems: [],
      pendingRestartKeys: ['K'],
    });
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'true', commit }),
      { wrapper },
    );

    await act(async () => {
      await result.current.fire('false');
    });

    expect(result.current.state).toBe('pending-restart');
    expect(result.current.current).toBe('false');
  });

  it('rolls back current on errors and shows error message', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'errors',
      errors: [{ path: 'K', message: 'bad value' }],
    });
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper },
    );

    await act(async () => {
      await result.current.fire('xxx');
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('bad value');
    // current rolled back to committed
    expect(result.current.current).toBe('false');
  });

  it('rolls back current on thrown exception', async () => {
    const commit = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper },
    );

    await act(async () => {
      await result.current.fire('true');
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('network down');
    expect(result.current.current).toBe('false');
  });

  it('sanitizes thrown error before writing to inline error (#3315054721)', async () => {
    // Without sanitization, a fetch-style error like `fetch failed at
    // http://internal.lan:8443/...` would render verbatim in FieldStatus,
    // leaking the self-host hostname into every screenshot. The hook
    // funnels through the same sanitizeErrorMessage helper as the toast
    // path, so the inline error shows `<url>` instead.
    const commit = vi
      .fn()
      .mockRejectedValue(new Error('fetch failed at http://internal.lan:8443/api/commit'));
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper },
    );
    await act(async () => {
      await result.current.fire('true');
    });
    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('fetch failed at <url>');
  });

  it('committed change resyncs current', () => {
    const commit = vi.fn();
    const { result, rerender } = renderHook(
      ({ committed }) => useToggleCommit({ envKey: 'K', committed, commit }),
      { wrapper, initialProps: { committed: 'false' } },
    );
    expect(result.current.current).toBe('false');
    rerender({ committed: 'true' });
    expect(result.current.current).toBe('true');
  });

  it('older fire resolving after newer fire does not stomp current state', async () => {
    // Verifies the inflightIdRef guard: when fire #1 (slow) is set up to
    // FAIL and fire #2 (fast) succeeds, fire #1's late error-rollback must
    // be suppressed — otherwise current would snap back to 'false' and state
    // to 'error', stomping fire #2's success.
    let resolveFirst!: (
      v:
        | { kind: 'ok'; updatedItems: never[]; pendingRestartKeys: never[] }
        | { kind: 'errors'; errors: Array<{ path: string; message: string }> },
    ) => void;
    let resolveSecond!: (v: {
      kind: 'ok';
      updatedItems: never[];
      pendingRestartKeys: never[];
    }) => void;
    const commit = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecond = r;
          }),
      );
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper },
    );
    // Fire two in quick succession.
    act(() => {
      void result.current.fire('a');
    });
    act(() => {
      void result.current.fire('b');
    });
    // Resolve newer (fire #2) FIRST with success.
    await act(async () => {
      resolveSecond({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    });
    expect(result.current.state).toBe('saved');
    expect(result.current.current).toBe('b');
    // Now resolve older (fire #1) with ERROR — its setCurrent(committedRef)
    // rollback + setState('error') must be suppressed by the inflightIdRef
    // guard. Without the guard, current would snap to 'false' and state to
    // 'error', erasing fire #2's outcome.
    await act(async () => {
      resolveFirst({
        kind: 'errors',
        errors: [{ path: 'K', message: 'stale failure should not surface' }],
      });
    });
    expect(result.current.state).toBe('saved'); // fire #2's outcome preserved
    expect(result.current.current).toBe('b'); // not rolled back to 'false'
    expect(result.current.error).toBeNull();
  });

  it('regression: unmount during in-flight commit does not throw', async () => {
    // The isMountedRef guard exists to suppress post-await setState after
    // the hook unmounts. React 18 silently no-ops such setState calls so
    // there's no thrown error / no console warning to assert against — this
    // test serves as a regression sentinel: if the post-await branch were
    // to throw (e.g. accessing a freed ref, calling a stale function), the
    // unhandled rejection from the awaiting fire() promise would surface
    // here. We capture that rejection and assert no error.
    let resolveCommit!: (v: {
      kind: 'ok';
      updatedItems: never[];
      pendingRestartKeys: never[];
    }) => void;
    const commit = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveCommit = r;
        }),
    );
    const { result, unmount } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper },
    );
    // Capture the fire() promise so we can observe its resolution post-unmount.
    let firePromise!: Promise<unknown>;
    act(() => {
      firePromise = result.current.fire('true');
    });
    unmount();
    // Resolve after unmount — the post-await branch runs against the now-
    // unmounted hook. The guard suppresses setState; the promise should
    // settle cleanly (no throw, no rejection) with `{kind:'superseded'}` so
    // callers can tell via exhaustive switch that the attempt was superseded
    // by unmount.
    await act(async () => {
      resolveCommit({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    });
    await expect(firePromise).resolves.toEqual({ kind: 'superseded' });
  });

  it('smoke: StrictMode wrapper does not break fire flow', async () => {
    // Renders the hook inside <StrictMode> and verifies the basic
    // optimistic-fire→commit→saved transition still works (no exceptions,
    // no stale state).
    //
    // NOTE: This is a smoke test, NOT a mutation sentinel for the
    // `isMountedRef.current = true` setup line in the effect body. The
    // mutation it would defend against (StrictMode dev cycle running
    // setup → cleanup → setup and leaving the ref stuck at false because
    // setup never restores it) only manifests with React's dev-only
    // effect-double-invoke, which vitest's jsdom env does not simulate.
    // Verified by mutation testing: deleting both `isMountedRef.current =
    // true` lines (use-field-commit.tsx:126,314) leaves all hook tests
    // green. The actual risk is HMR / Fast Refresh / dev-mode StrictMode,
    // confirmed manually in `pnpm dev`. If a regression there is
    // suspected, run the dev server and toggle the SSRF field.
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      updatedItems: [],
      pendingRestartKeys: [],
    });
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper: strictWrapper },
    );
    await act(async () => {
      await result.current.fire('true');
    });
    expect(result.current.state).toBe('saved');
    expect(result.current.current).toBe('true');
  });

  it('clear() snaps current back to committed (symmetric with useEditableCommit)', async () => {
    // Regression for ABI asymmetry: useEditableCommit.clear() resets
    // draft → committed, but useToggleCommit.clear() previously left
    // `current` (optimistic) alone. If a Reset arrives between an
    // optimistic fire and the parent's setStore-driven committed prop
    // change, the toggle would briefly render the stale optimistic value.
    // clear() now mirrors editable's behaviour and snaps to committedRef.
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      updatedItems: [],
      pendingRestartKeys: [],
    });
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper },
    );
    await act(async () => {
      await result.current.fire('true');
    });
    expect(result.current.current).toBe('true'); // optimistic
    act(() => result.current.clear());
    expect(result.current.current).toBe('false'); // snapped back
    expect(result.current.state).toBe('pristine');
  });

  it('clear() resets state to pristine from error', async () => {
    // External Reset paths (resetEnvKey via shell) bypass the hook entirely;
    // caller signals "I changed the field through a different channel,
    // please forget your prior attempt's state" via clear(). Without this
    // the row keeps showing a stale "Save failed" red strip after the
    // override has been removed.
    const commit = vi.fn().mockResolvedValue({
      kind: 'errors',
      errors: [{ path: 'K', message: 'bad' }],
    });
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper },
    );
    await act(async () => {
      await result.current.fire('true');
    });
    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('bad');
    act(() => result.current.clear());
    expect(result.current.state).toBe('pristine');
    expect(result.current.error).toBeNull();
  });

  it('clear() suppresses late-resolving commit from stomping pristine state', async () => {
    // Critical invariant: clear() must bump inflightIdRef so a still-pending
    // commit's late resolve cannot setState('saved') or setState('error')
    // after the field has been "reset" externally. Without the bump, the
    // user clicks Reset, the row clears, then 200ms later the original
    // toggle commit lands and re-paints "Saved · restart" — confusing.
    let resolveCommit!: (v: {
      kind: 'ok';
      updatedItems: never[];
      pendingRestartKeys: never[];
    }) => void;
    const commit = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveCommit = r;
        }),
    );
    const { result } = renderHook(
      () => useToggleCommit({ envKey: 'K', committed: 'false', commit }),
      { wrapper },
    );
    // Kick off a commit that won't resolve yet.
    act(() => {
      void result.current.fire('true');
    });
    expect(result.current.state).toBe('saving');
    // External action: caller invokes clear() (e.g. Reset button success).
    act(() => result.current.clear());
    expect(result.current.state).toBe('pristine');
    // Now resolve the late commit — pristine state must hold.
    await act(async () => {
      resolveCommit({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    });
    expect(result.current.state).toBe('pristine'); // not 'saved'
  });

  it('rollback reads freshest committed (committedRef, not closure)', async () => {
    // Verifies committedRef: if `committed` prop shifts while a commit is in
    // flight and then the commit fails, rollback must snap to the NEW
    // committed value (read from ref), not the stale closure-captured value.
    let rejectCommit!: (e: Error) => void;
    const commit = vi.fn().mockImplementation(
      () =>
        new Promise((_r, rej) => {
          rejectCommit = rej;
        }),
    );
    const { result, rerender } = renderHook(
      ({ committed }) => useToggleCommit({ envKey: 'K', committed, commit }),
      { wrapper, initialProps: { committed: 'false' } },
    );
    act(() => {
      void result.current.fire('true');
    });
    // Out-of-band change to committed mid-flight.
    rerender({ committed: 'updated' });
    // Commit fails — rollback should target the NEW committed.
    await act(async () => {
      rejectCommit(new Error('network'));
    });
    expect(result.current.state).toBe('error');
    expect(result.current.current).toBe('updated'); // ref, not 'false'
  });
});

describe('useEditableCommit', () => {
  it('starts pristine with draft === committed', () => {
    const commit = vi.fn();
    const { result } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'initial', commit }),
      { wrapper },
    );
    expect(result.current.draft).toBe('initial');
    expect(result.current.dirty).toBe(false);
    expect(result.current.state).toBe('pristine');
  });

  it('marks dirty when draft diverges', () => {
    const commit = vi.fn();
    const { result } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'a', commit }),
      { wrapper },
    );
    act(() => result.current.setDraft('b'));
    expect(result.current.dirty).toBe(true);
  });

  it('save() commits draft and transitions saved', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      updatedItems: [],
      pendingRestartKeys: [],
    });
    const { result } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'a', commit }),
      { wrapper },
    );
    act(() => result.current.setDraft('b'));
    await act(async () => {
      await result.current.save();
    });
    expect(commit).toHaveBeenCalledWith({ K: 'b' });
    expect(result.current.state).toBe('saved');
  });

  it('save() pristine no-op returns no-op outcome (distinct from saved)', async () => {
    const commit = vi.fn();
    const { result } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'a', commit }),
      { wrapper },
    );
    let returned!: Awaited<ReturnType<typeof result.current.save>>;
    await act(async () => {
      returned = await result.current.save();
    });
    expect(commit).not.toHaveBeenCalled();
    // 'no-op' instead of 'saved' so callers can distinguish "I persisted
    // something" from "there was nothing to persist". account.tsx always
    // passes overrideValue so it never sees this branch, but future text /
    // secret field consumers that drive save() from button clicks need to
    // know whether the server actually round-tripped.
    expect(returned).toEqual({ kind: 'no-op' });
  });

  it('save(overrideValue) commits override bypassing draft', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      updatedItems: [],
      pendingRestartKeys: [],
    });
    const { result } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'a', commit }),
      { wrapper },
    );
    // Caller passes the value directly without setDraft first (avoids
    // the stale-closure race when external state is the source of truth).
    let returned!: Awaited<ReturnType<typeof result.current.save>>;
    await act(async () => {
      returned = await result.current.save('explicit-value');
    });
    expect(commit).toHaveBeenCalledWith({ K: 'explicit-value' });
    expect(returned).toEqual({ kind: 'saved' });
  });

  it('save() returns error outcome on errors', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'errors',
      errors: [{ path: 'K', message: 'invalid' }],
    });
    const { result } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'a', commit }),
      { wrapper },
    );
    let returned!: Awaited<ReturnType<typeof result.current.save>>;
    await act(async () => {
      returned = await result.current.save('x');
    });
    expect(returned).toEqual({ kind: 'error', message: 'invalid' });
    expect(result.current.state).toBe('error');
  });

  it('cancel() reverts draft to committed', () => {
    const commit = vi.fn();
    const { result } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'a', commit }),
      { wrapper },
    );
    act(() => result.current.setDraft('b'));
    act(() => result.current.cancel());
    expect(result.current.draft).toBe('a');
    expect(result.current.dirty).toBe(false);
  });

  it('clear() resets draft AND state to pristine after error', async () => {
    // External Reset (resetEnvKey via shell) needs the hook to forget both
    // draft AND error state. cancel() only handles the latter when state is
    // 'error'; clear() does both unconditionally so the row is in a clean
    // post-reset state.
    const commit = vi.fn().mockResolvedValue({
      kind: 'errors',
      errors: [{ path: 'K', message: 'too-weak' }],
    });
    const { result } = renderHook(() => useEditableCommit({ envKey: 'K', committed: '', commit }), {
      wrapper,
    });
    await act(async () => {
      await result.current.save('bad');
    });
    expect(result.current.state).toBe('error');
    act(() => result.current.setDraft('drafty'));
    act(() => result.current.clear());
    expect(result.current.state).toBe('pristine');
    expect(result.current.error).toBeNull();
    expect(result.current.draft).toBe(''); // back to committedRef
  });

  it('clear() suppresses late-resolving save from stomping pristine state', async () => {
    // Same inflightIdRef-bump invariant as useToggleCommit.clear — a still-
    // pending save's late resolve must not be allowed to setState after
    // clear() has been called.
    let resolveCommit!: (v: {
      kind: 'ok';
      updatedItems: never[];
      pendingRestartKeys: never[];
    }) => void;
    const commit = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveCommit = r;
        }),
    );
    const { result } = renderHook(() => useEditableCommit({ envKey: 'K', committed: '', commit }), {
      wrapper,
    });
    act(() => {
      void result.current.save('x');
    });
    expect(result.current.state).toBe('saving');
    act(() => result.current.clear());
    expect(result.current.state).toBe('pristine');
    await act(async () => {
      resolveCommit({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    });
    expect(result.current.state).toBe('pristine'); // not 'saved'
  });

  it('error state cleared on cancel', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'errors',
      errors: [{ path: 'K', message: 'bad' }],
    });
    const { result } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'a', commit }),
      { wrapper },
    );
    act(() => result.current.setDraft('b'));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.state).toBe('error');
    act(() => result.current.cancel());
    expect(result.current.state).toBe('pristine');
    expect(result.current.error).toBeNull();
  });

  it('serialize transforms draft before commit', async () => {
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      updatedItems: [],
      pendingRestartKeys: [],
    });
    const { result } = renderHook(
      () =>
        useEditableCommit({
          envKey: 'K',
          committed: '100',
          commit,
          serialize: (d) => (d === '' ? null : d),
        }),
      { wrapper },
    );
    act(() => result.current.setDraft(''));
    await act(async () => {
      await result.current.save();
    });
    expect(commit).toHaveBeenCalledWith({ K: null });
  });

  it('committed change resets draft when user is pristine', () => {
    const commit = vi.fn();
    const { result, rerender } = renderHook(
      ({ committed }) => useEditableCommit({ envKey: 'K', committed, commit }),
      { wrapper, initialProps: { committed: 'a' } },
    );
    expect(result.current.draft).toBe('a');
    rerender({ committed: 'c' });
    expect(result.current.draft).toBe('c');
  });

  it('committed change preserves user draft when mid-edit', () => {
    // Out-of-band committed update (another tab saved, server pushed) must
    // NOT silently overwrite the user's in-progress draft. The committedRef
    // still picks up the new baseline (so cancel reverts to it), but draft
    // is held until the user explicitly saves or cancels.
    const commit = vi.fn();
    const { result, rerender } = renderHook(
      ({ committed }) => useEditableCommit({ envKey: 'K', committed, commit }),
      { wrapper, initialProps: { committed: 'a' } },
    );
    act(() => {
      result.current.setDraft('user-edit');
    });
    expect(result.current.draft).toBe('user-edit');
    // committed shifts mid-edit. User's draft must survive.
    rerender({ committed: 'updated' });
    expect(result.current.draft).toBe('user-edit'); // preserved, not clobbered
    // But cancel() should still revert to the NEW committed baseline because
    // committedRef tracked the update.
    act(() => {
      result.current.cancel();
    });
    expect(result.current.draft).toBe('updated');
  });

  it('older save resolving after newer save does not stomp newer state', async () => {
    // Mirrors the useToggleCommit inflightIdRef test: when save #1 (slow) is
    // set up to FAIL and save #2 (fast) succeeds, save #1's late error path
    // must be suppressed by the inflightIdRef guard — otherwise state would
    // snap from 'saved' back to 'error'. Uses overrideValue to sidestep the
    // dirty check so both calls actually run.
    let resolveFirst!: (
      v:
        | { kind: 'ok'; updatedItems: never[]; pendingRestartKeys: never[] }
        | { kind: 'errors'; errors: Array<{ path: string; message: string }> },
    ) => void;
    let resolveSecond!: (v: {
      kind: 'ok';
      updatedItems: never[];
      pendingRestartKeys: never[];
    }) => void;
    const commit = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecond = r;
          }),
      );
    const { result } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'a', commit }),
      { wrapper },
    );
    act(() => {
      void result.current.save('first');
    });
    act(() => {
      void result.current.save('second');
    });
    // Newer save resolves first with success.
    await act(async () => {
      resolveSecond({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    });
    expect(result.current.state).toBe('saved');
    // Older save's late error must NOT surface — inflightIdRef guard suppresses it.
    await act(async () => {
      resolveFirst({
        kind: 'errors',
        errors: [{ path: 'K', message: 'stale failure should not surface' }],
      });
    });
    expect(result.current.state).toBe('saved'); // newer save outcome preserved
    expect(result.current.error).toBeNull();
  });

  it('regression: unmount during in-flight save does not throw', async () => {
    // Mirrors useToggleCommit's isMountedRef test. React 18 silently no-ops
    // post-unmount setState, so absent the guard we'd instead detect an
    // unhandled rejection from the awaiting save() promise. Capture it and
    // assert no error.
    let resolveCommit!: (v: {
      kind: 'ok';
      updatedItems: never[];
      pendingRestartKeys: never[];
    }) => void;
    const commit = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveCommit = r;
        }),
    );
    const { result, unmount } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'a', commit }),
      { wrapper },
    );
    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = result.current.save('x');
    });
    unmount();
    await act(async () => {
      resolveCommit({ kind: 'ok', updatedItems: [], pendingRestartKeys: [] });
    });
    // Post-unmount the guarded branch returns `{kind:'superseded'}` rather
    // than throwing — discriminated outcome for callers to recognise
    // "attempt was superseded" via exhaustive switch.
    await expect(savePromise).resolves.toEqual({ kind: 'superseded' });
  });

  it('cancel reads freshest committed (committedRef, not closure)', async () => {
    // Verifies committedRef in cancel(): when `committed` shifts mid-edit,
    // committedRef must track the new value so cancel reverts to the latest
    // baseline rather than the stale closure-captured one. Mid-edit draft
    // preservation is covered by the test above; this one drives a second
    // edit AFTER the out-of-band shift to isolate the ref-vs-closure mutation.
    const commit = vi.fn();
    const { result, rerender } = renderHook(
      ({ committed }) => useEditableCommit({ envKey: 'K', committed, commit }),
      { wrapper, initialProps: { committed: 'a' } },
    );
    act(() => {
      result.current.setDraft('first-edit');
    });
    // committed shifts (out-of-band). committedRef updates; draft preserved.
    rerender({ committed: 'updated' });
    expect(result.current.draft).toBe('first-edit');
    // Second edit on top of the new baseline.
    act(() => {
      result.current.setDraft('second-edit');
    });
    act(() => {
      result.current.cancel();
    });
    expect(result.current.draft).toBe('updated'); // ref, not stale 'a'
  });

  it('smoke: StrictMode wrapper does not break save flow', async () => {
    // Same smoke-test scope as the useToggleCommit StrictMode test — see
    // that test's comment for why this is not a mutation sentinel for the
    // `isMountedRef.current = true` setup line.
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      updatedItems: [],
      pendingRestartKeys: [],
    });
    const { result } = renderHook(
      () => useEditableCommit({ envKey: 'K', committed: 'a', commit }),
      { wrapper: strictWrapper },
    );
    let outcome!: Awaited<ReturnType<typeof result.current.save>>;
    await act(async () => {
      outcome = await result.current.save('b');
    });
    expect(outcome).toEqual({ kind: 'saved' });
    expect(result.current.state).toBe('saved');
  });
});
