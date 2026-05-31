import { GoldpanApiError } from '@goldpan/web-sdk';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUpdateNote = vi.fn();
const mockInput = vi.fn();

vi.mock('@/lib/api-client-browser', () => ({
  getBrowserApiClient: () => ({
    updateNote: mockUpdateNote,
    input: mockInput,
  }),
}));

import { useReclassifyNote } from './use-reclassify-note';

describe('useReclassifyNote', () => {
  beforeEach(() => {
    mockUpdateNote.mockReset();
    mockInput.mockReset();
    mockUpdateNote.mockResolvedValue({ id: 5, archived: true });
    mockInput.mockResolvedValue({ type: 'query', answer: 'mock', confidence: 'medium' });
  });

  it('archives original note + dispatches forcedIntent + emits onSuccess with dispatchedResult', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useReclassifyNote({ onSuccess }));
    await act(async () => {
      await result.current.reclassify({
        noteId: 5,
        originalContent: 'foo',
        targetIntentKey: 'query',
        conversationId: 99,
      });
    });
    expect(mockUpdateNote).toHaveBeenCalledWith(5, { archived: true });
    expect(mockInput).toHaveBeenCalledWith({
      input: 'foo',
      forcedIntent: 'query',
      conversationId: 99,
    });
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        noteId: 5,
        targetIntentKey: 'query',
        originalContent: 'foo',
        dispatchedResult: expect.objectContaining({ type: 'query' }),
        // F-RECLASSIFY-NEW-CONV-SILENT: normal path didn't take the
        // archived-conversation retry, so caller must see `false`.
        fellBackToSession: false,
      }),
    );
  });

  it('does not call onSuccess when updateNote throws', async () => {
    mockUpdateNote.mockRejectedValueOnce(new Error('boom'));
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useReclassifyNote({ onSuccess, onError }));
    await act(async () => {
      await result.current.reclassify({
        noteId: 5,
        originalContent: 'foo',
        targetIntentKey: 'query',
      });
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    // archive 失败时不应该 dispatch
    expect(mockInput).not.toHaveBeenCalled();
  });

  // P5 二轮 review N2: archive 成功 + dispatch 失败 → unarchive 回滚安全网
  it('rolls back archive when client.input throws (二轮 review N2 安全网)', async () => {
    mockUpdateNote
      .mockResolvedValueOnce({ id: 5, archived: true }) // archive 成功
      .mockResolvedValueOnce({ id: 5, archived: false }); // rollback unarchive
    mockInput.mockRejectedValueOnce(new Error('dispatch failed'));
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useReclassifyNote({ onSuccess, onError }));
    await act(async () => {
      await result.current.reclassify({
        noteId: 5,
        originalContent: 'foo',
        targetIntentKey: 'query',
      });
    });
    expect(mockUpdateNote).toHaveBeenNthCalledWith(1, 5, { archived: true });
    expect(mockUpdateNote).toHaveBeenNthCalledWith(2, 5, { archived: false });
    expect(mockInput).toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  // P5 Fix Batch 3 (I9) + Batch 7 thread #4: dispatch 失败 + rollback unarchive
  // 也失败时，onRollbackFailed 触发后 onError **不再调用** —— caller 的
  // rollback-aware 文案（原 note 仍 archived → 告诉用户去归档列表恢复）
  // 不会被通用 dispatch error banner 覆盖。
  it('I9 + thread #4: calls onRollbackFailed and SKIPS onError when unarchive fails (rollback-specific message wins)', async () => {
    const originalErr = new Error('dispatch failed');
    const rollbackErr = new Error('rollback failed');
    mockUpdateNote
      .mockResolvedValueOnce({ id: 5, archived: true }) // archive 成功
      .mockRejectedValueOnce(rollbackErr); // rollback 失败
    mockInput.mockRejectedValueOnce(originalErr);

    const onError = vi.fn();
    const onRollbackFailed = vi.fn();

    const { result } = renderHook(() => useReclassifyNote({ onError, onRollbackFailed }));
    await act(async () => {
      await result.current.reclassify({
        noteId: 5,
        originalContent: 'foo',
        targetIntentKey: 'query',
      });
    });
    expect(onRollbackFailed).toHaveBeenCalledWith(rollbackErr, originalErr);
    // Batch 7 thread #4: onError must NOT fire — caller-injected
    // rollback-aware message keeps the banner; generic onError would overwrite.
    expect(onError).not.toHaveBeenCalled();
  });

  // PR #57 thread #8: source conversation 被 archive 后再 reclassify，server
  // 返回 409 `conversation_archived`。hook 自动重试去掉 conversationId，落回
  // sessionKey 新建/复用对话，dispatch 成功 → onSuccess 正常触发，没有
  // rollback。验证 mockInput 被调两次：第一次带 conversationId，第二次不带。
  it('thread #8: fallback dispatch without conversationId when source conversation is archived', async () => {
    mockUpdateNote.mockResolvedValueOnce({ id: 5, archived: true });
    const archivedErr = new GoldpanApiError('archived', 'conversation_archived', 409);
    mockInput
      .mockRejectedValueOnce(archivedErr) // first attempt: 409
      .mockResolvedValueOnce({ type: 'query', answer: 'mock', confidence: 'medium' });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useReclassifyNote({ onSuccess, onError }));
    await act(async () => {
      await result.current.reclassify({
        noteId: 5,
        originalContent: 'foo',
        targetIntentKey: 'query',
        conversationId: 99,
        sessionKey: 'web-session-abc',
      });
    });
    expect(mockInput).toHaveBeenCalledTimes(2);
    expect(mockInput).toHaveBeenNthCalledWith(1, {
      input: 'foo',
      forcedIntent: 'query',
      sessionKey: 'web-session-abc',
      conversationId: 99,
    });
    // Retry strips conversationId so server creates/reuses a current conversation.
    expect(mockInput).toHaveBeenNthCalledWith(2, {
      input: 'foo',
      forcedIntent: 'query',
      sessionKey: 'web-session-abc',
    });
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchedResult: expect.objectContaining({ type: 'query' }),
        // F-RECLASSIFY-NEW-CONV-SILENT: retry path executed → caller must
        // see `true` so it can surface a "switched conversation" notice.
        fellBackToSession: true,
      }),
    );
    expect(onError).not.toHaveBeenCalled();
    // No rollback — archive stays, dispatch eventually succeeded.
    expect(mockUpdateNote).toHaveBeenCalledTimes(1);
  });

  // PR #57 thread #8 反面：非 archived 错误码（如普通 500）走原 rollback 路径，
  // 不重试。验证 mockInput 只被调一次，rollback unarchive 跑了，onError 正常触发。
  it('thread #8: non-archived error does NOT retry, falls through to existing rollback path', async () => {
    mockUpdateNote
      .mockResolvedValueOnce({ id: 5, archived: true })
      .mockResolvedValueOnce({ id: 5, archived: false });
    const otherErr = new GoldpanApiError('boom', 'internal_error', 500);
    mockInput.mockRejectedValueOnce(otherErr);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useReclassifyNote({ onSuccess, onError }));
    await act(async () => {
      await result.current.reclassify({
        noteId: 5,
        originalContent: 'foo',
        targetIntentKey: 'query',
        conversationId: 99,
      });
    });
    expect(mockInput).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(otherErr);
    // rollback ran
    expect(mockUpdateNote).toHaveBeenNthCalledWith(2, 5, { archived: false });
  });

  // Batch 7 thread #4 互斥行为反面：rollback **成功**时 onError 仍按原路径
  // 调用 —— caller 能看到 dispatch 错误，原 note 已 unarchive 回来。
  it('thread #4: still calls onError when dispatch fails but rollback succeeds', async () => {
    const originalErr = new Error('dispatch failed');
    mockUpdateNote
      .mockResolvedValueOnce({ id: 5, archived: true }) // archive 成功
      .mockResolvedValueOnce({ id: 5, archived: false }); // rollback 成功
    mockInput.mockRejectedValueOnce(originalErr);

    const onError = vi.fn();
    const onRollbackFailed = vi.fn();

    const { result } = renderHook(() => useReclassifyNote({ onError, onRollbackFailed }));
    await act(async () => {
      await result.current.reclassify({
        noteId: 5,
        originalContent: 'foo',
        targetIntentKey: 'query',
      });
    });
    expect(onRollbackFailed).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(originalErr);
  });

  // T7 — caller omits `onRollbackFailed`: rollback failure must fall through
  // to plain `onError(originalErr)` instead of becoming a silent dead end.
  it('T7: falls back to onError when caller does not provide onRollbackFailed and rollback fails', async () => {
    const originalErr = new Error('dispatch failed');
    const rollbackErr = new Error('rollback failed');
    mockUpdateNote
      .mockResolvedValueOnce({ id: 5, archived: true })
      .mockRejectedValueOnce(rollbackErr);
    mockInput.mockRejectedValueOnce(originalErr);

    const onError = vi.fn();
    // No onRollbackFailed injected — fallback path.
    const { result } = renderHook(() => useReclassifyNote({ onError }));
    await act(async () => {
      await result.current.reclassify({
        noteId: 5,
        originalContent: 'foo',
        targetIntentKey: 'query',
      });
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(originalErr);
  });

  // T8 — reference stability: `reclassify` identity must NOT change when
  // callers pass a fresh `{onSuccess, onError, ...}` object every render.
  // The hook holds options behind a ref so consumer memo chains
  // (MessageList → MessageBubble) don't get invalidated each parent render.
  it('T8: reclassify reference stays identical across re-renders even when options object identity churns', () => {
    const { result, rerender } = renderHook(
      ({ tag }: { tag: number }) =>
        useReclassifyNote({ onSuccess: () => void tag, onError: () => void tag }),
      { initialProps: { tag: 1 } },
    );
    const first = result.current.reclassify;
    rerender({ tag: 2 });
    rerender({ tag: 3 });
    expect(result.current.reclassify).toBe(first);
  });

  // T9 — unmount mid-dispatch: an in-flight archive PATCH that resolves AFTER
  // the consumer unmounts must not throw or warn. React 18+ ignores setState
  // on unmounted components silently, but the hook should still not crash on
  // its own (e.g. via callbacks called on a stale closure). We assert no
  // exception and no `console.error` spam.
  it('T9: does not throw when consumer unmounts mid-dispatch', async () => {
    let resolveUpdate: ((v: { id: number; archived: boolean }) => void) | undefined;
    mockUpdateNote.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveUpdate = res;
        }),
    );
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSuccess = vi.fn();
    const { result, unmount } = renderHook(() => useReclassifyNote({ onSuccess }));
    // Kick off the dispatch but DON'T await — we want it pending across unmount.
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.reclassify({
        noteId: 5,
        originalContent: 'foo',
        targetIntentKey: 'query',
      });
    });
    unmount();
    // Now resolve the in-flight archive — dispatch will run and try to call
    // onSuccess on the (still-live) options ref. The hook itself shouldn't
    // throw, and console.error shouldn't fire for hook-internal reasons.
    await act(async () => {
      resolveUpdate?.({ id: 5, archived: true });
      await pending;
    });
    // Hook didn't crash; onSuccess still fires because options ref is live.
    expect(onSuccess).toHaveBeenCalledTimes(1);
    // No internal failure log from the hook (no rollback path, no try/catch fire).
    expect(consoleErrSpy).not.toHaveBeenCalled();
    consoleErrSpy.mockRestore();
  });
});
