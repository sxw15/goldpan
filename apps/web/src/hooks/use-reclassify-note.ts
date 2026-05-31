'use client';

import { GoldpanApiError, type InputResult } from '@goldpan/web-sdk';
import { useCallback, useRef, useState } from 'react';
import { getBrowserApiClient } from '@/lib/api-client-browser';

interface ReclassifyParams {
  noteId: number;
  originalContent: string;
  /** Target intent: 'query' / 'submit_url' / 'submit_text' / 'create_tracking'.
   * Server 拿 `forcedIntent` 跳过 classifier 直接走对应 plugin。 */
  targetIntentKey: string;
  /** Optional — when caller is in a chat conversation context, threads through
   * so the new dispatch lands in the same conversation. */
  conversationId?: number;
  /** Optional — defaults handled server-side. Web caller passes WEB_SESSION_KEY. */
  sessionKey?: string;
}

interface UseReclassifyNoteOptions {
  /** Called after archive + dispatch both succeeded. `dispatchedResult` is the
   * /input response — caller decides UI reaction (chat inline render vs
   * inspector close + router.push).
   *
   * `fellBackToSession` is `true` when the dispatch retry fired because the
   * caller-provided `conversationId` pointed at an archived conversation
   * (server returned 409 `conversation_archived`). Caller should surface a
   * "switched conversation" notice so the user knows their dispatch landed
   * in a *different* conversation than the one they were viewing. `false`
   * for the normal happy path (no fallback executed). */
  onSuccess?: (
    p: ReclassifyParams & { dispatchedResult: InputResult; fellBackToSession: boolean },
  ) => void;
  onError?: (err: Error) => void;
  /** P5 Fix Batch 3 (I9) + Batch 7 thread #4: dispatch 失败后 rollback unarchive
   * 也失败时调用。`originalErr` 是 dispatch 抛出的、用户原本看到的错误；
   * `rollbackErr` 是 unarchive 失败本身。
   *
   * 关键：rollback 失败路径**互斥**于 `onError` —— 当 onRollbackFailed 触发时
   * `onError` 不再调用，避免 caller 注入的通用 dispatch error banner 覆盖
   * rollback-specific 文案（原 note 仍 archived，用户视角更严重 → 需告诉去
   * 归档列表恢复）。未提供 onRollbackFailed 时退回普通错误流程：
   * `console.error` rollback 然后 `onError(originalErr)`。 */
  onRollbackFailed?: (rollbackErr: Error, originalErr: Error) => void;
}

export function useReclassifyNote(options?: UseReclassifyNoteOptions) {
  const [isReclassifying, setIsReclassifying] = useState(false);
  // P5 Fix Batch 6 (M1): keep `options` behind a ref so callers' literal
  // `{onSuccess, onError, ...}` (identity-churns each render) doesn't churn
  // `reclassify` identity → MessageList prop chain → MessageBubble memo
  // (`onReclassify` prop). Without the ref, every parent render re-renders
  // every bubble.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // PR #57 F-RECLASSIFY-NO-IN-FLIGHT-GUARD: `isReclassifying` state is async —
  // React 18 batches `setIsReclassifying(true)` so a second click landing in
  // the same tick reads `disabled=false` and races two archive PATCH + dispatch
  // pairs. The ref flips synchronously inside the callback so the second click
  // bails immediately. The state setter still drives the visual disable.
  const inFlightRef = useRef(false);

  const reclassify = useCallback(async (params: ReclassifyParams) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsReclassifying(true);
    const client = getBrowserApiClient();
    let archived = false;
    try {
      // 1) archive original note
      await client.updateNote(params.noteId, { archived: true });
      archived = true;
      // 2) dispatch as new intent via forcedIntent — server skips classifier.
      // PR #57 thread #8: when caller passes a `conversationId` pointing at
      // an archived conversation (e.g. Library inspector reclassifies a note
      // whose source conversation was later archived), server returns 409
      // `conversation_archived`. Without a fallback, dispatch fails → rollback
      // unarchives the note → user can't reclassify. Retry under sessionKey
      // alone so the dispatch lands in a fresh / current conversation instead
      // of failing the whole flow.
      const baseInputArgs = {
        input: params.originalContent,
        forcedIntent: params.targetIntentKey,
        ...(params.sessionKey !== undefined && { sessionKey: params.sessionKey }),
      };
      let dispatchedResult: InputResult;
      // PR #57 F-RECLASSIFY-NEW-CONV-SILENT: surface to caller whether the
      // retry path was taken so it can show a "switched conversation" notice
      // — otherwise user sees their dispatch silently land in a different
      // conversation than the one they clicked from.
      let fellBackToSession = false;
      try {
        dispatchedResult = await client.input({
          ...baseInputArgs,
          ...(params.conversationId !== undefined && { conversationId: params.conversationId }),
        });
      } catch (e) {
        if (e instanceof GoldpanApiError && e.code === 'conversation_archived') {
          dispatchedResult = await client.input(baseInputArgs);
          fellBackToSession = true;
        } else {
          throw e;
        }
      }
      optionsRef.current?.onSuccess?.({ ...params, dispatchedResult, fellBackToSession });
    } catch (err) {
      // PR #57 F-RECLASSIFY-NO-CONTEXT-LOG: include params so six-months-later
      // debugging works — bare `[useReclassifyNote] failed <Error>` gives zero
      // context about which note / intent / conversation was being reclassified.
      console.error('[useReclassifyNote] failed', {
        noteId: params.noteId,
        intent: params.targetIntentKey,
        conversationId: params.conversationId,
        err,
      });
      // PR #57 F-RECLASSIFY-WRAP-ERR: wrap with `cause` so the original error
      // (incl. GoldpanApiError.code/status/stack) is preserved when caller
      // inspects `err.cause` — `new Error(String(err))` discards everything.
      const originalErr = err instanceof Error ? err : new Error(String(err), { cause: err });
      // P5 二轮 review N2: dispatch 失败时 unarchive 原 note 回滚，避免用户内容
      // 丢失（原 note archived 隐藏 + 新 result 没出现 = 彻底失踪）。
      let rollbackFailedHandled = false;
      if (archived) {
        try {
          await client.updateNote(params.noteId, { archived: false });
        } catch (rollbackErr) {
          // P5 Fix Batch 3 (I9) + Batch 7 thread #4: rollback 失败时，
          // console.error 不够 —— 原 note 现在 archived 隐藏在默认视图外，
          // 用户不知道去归档列表恢复。优先调用 caller 注入的 onRollbackFailed
          // （rollback-aware 文案）。当 onRollbackFailed 被注入并触发时，
          // 不再调 onError —— 否则 caller 的 onError 会用通用 dispatch error
          // banner 覆盖 rollback-specific 文案。未注入 onRollbackFailed 时
          // 退回普通错误流程（log + onError 仍跑）。
          // F-RECLASSIFY-NO-CONTEXT-LOG: same context discipline applies here.
          console.error('[useReclassifyNote] rollback unarchive failed', {
            noteId: params.noteId,
            intent: params.targetIntentKey,
            conversationId: params.conversationId,
            rollbackErr,
          });
          // F-RECLASSIFY-WRAP-ERR: preserve original via `cause`.
          const rbErr =
            rollbackErr instanceof Error
              ? rollbackErr
              : new Error(String(rollbackErr), { cause: rollbackErr });
          const cb = optionsRef.current?.onRollbackFailed;
          if (cb) {
            cb(rbErr, originalErr);
            rollbackFailedHandled = true;
          }
        }
      }
      if (!rollbackFailedHandled) {
        optionsRef.current?.onError?.(originalErr);
      }
    } finally {
      inFlightRef.current = false;
      setIsReclassifying(false);
    }
  }, []);

  return { reclassify, isReclassifying };
}
