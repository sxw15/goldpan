// P3 Buffer Path B — HTTP endpoints for explicit release / cancel of a
// buffered_wait message. Pairs with Path A (handleInput's pre-append
// findAndMergeBuffered) and Path E (buffer-watcher cron) which both feed into
// the same finalizeBuffer CAS terminus. Reading order:
//
//   - .agent/input-query.md §"5 触发路径"
//   - packages/core/src/conversation/buffer-finalize.ts — finalizeBuffer
//
// Both endpoints are idempotent at the CAS layer: concurrent callers racing
// the same messageId only see one execution. The non-winning caller gets a
// 200 with `executed: false` / `cancelled: false` plus a `reason` field so
// the UI can distinguish "the cron beat me to it" from a true error.
//
// Path D schedulers (scheduleReconcileForSession / forConversation) live here
// too — same domain (buffered messages), same dependency-shape construction
// (HandleInputRepos subset). Co-locating keeps the HandleInputRepos subset
// build in one file so future fields don't have to be re-added in two places.

import type { BootstrapHandle } from '@goldpan/core/bootstrap';
import { finalizeBuffer } from '@goldpan/core/conversation';
import { errorMessage } from '@goldpan/core/errors';
import { handleInput } from '@goldpan/core/input';
import { serializeHandleInputResult } from './input-wire.js';
import { type RouteContext, respond, respondError } from './types.js';

/**
 * Build the HandleInputRepos subset finalizeBuffer expects. Extracted from the
 * release handler so both the HTTP path and Path D schedulers route through
 * the same call shape — adding a future field to HandleInputRepos only needs
 * a one-line edit here instead of three identical update sites.
 */
function buildFinalizeDeps(handle: BootstrapHandle): Parameters<typeof finalizeBuffer>[1] {
  return {
    db: handle.db,
    repos: {
      llmCall: handle.repos.llmCall,
      submissionLog: handle.repos.submissionLog,
      knowledge: handle.repos.knowledge,
      category: handle.repos.category,
      notes: handle.repos.notes,
      source: handle.repos.source,
      conversation: handle.repos.conversation,
    },
    logger: handle.logger,
    handleInput,
    callLlm: handle.callLlm,
    pluginRegistry: handle.pluginRegistry,
    config: handle.config,
    embeddingProvider: handle.embeddingProvider,
  };
}

/**
 * Path D grace window. 5s mirrors handleInput Path C — both are user-initiated
 * reconcile (the user is right there), so a tight grace is fine. Path E cron
 * uses 30s because it sweeps globally and shouldn't race with `findAndMerge`
 * on a buffer that just expired.
 */
const PATH_D_GRACE_MS = 5_000;
/** Cap the per-tick fan-out: a session/conversation should rarely have more
 * than a handful of expired buffers; 20 leaves headroom without unbounded
 * latency if something goes wrong upstream. */
const PATH_D_LIMIT = 20;
/** Shared with apps/server/src/main.ts —— single source of truth for the web
 * channel's synthetic sessionKey. Bumping or namespacing this in the future
 * only needs one edit. */
export const WEB_SESSION_KEY = 'web:default';

/**
 * P3 Path D — GET /conversations/active reconcile. User comes back to the
 * chat surface; any expired buffered_wait messages in their session need to
 * be finalized so the next GET sees a real assistant turn instead of a
 * dangling indicator.
 *
 * **Fire-and-forget by design** (P3 二轮 review 取舍 13): if we awaited
 * `finalizeBuffer` synchronously, N expired buffers × LLM latency would
 * stretch GET /conversations from "instant" to multi-second. Active-fetch
 * has to stay snappy — the UI shows current state immediately, and the
 * caller's next poll (or the client-side release timer) picks up the
 * finalize result. Path D is defensive: client-side release timer (Task 11)
 * is the primary trigger; this only runs when that path fails.
 *
 * Sync throws from `findExpiredBuffered` are caught at the outer try so a
 * route handler that calls this never sees an uncaught rejection. Per-buffer
 * `finalizeBuffer` failures are logged + swallowed — the rest of the batch
 * still gets a chance, and Path E cron retries anything still expired.
 */
export function scheduleReconcileForSession(sessionKey: string, handle: BootstrapHandle): void {
  void (async () => {
    try {
      const expired = handle.repos.conversation.findExpiredBufferedBySession(
        sessionKey,
        PATH_D_GRACE_MS,
        PATH_D_LIMIT,
      );
      const deps = buildFinalizeDeps(handle);
      for (const exp of expired) {
        try {
          await finalizeBuffer(exp.id, deps);
        } catch (err) {
          handle.logger.warn('Path D reconcile (session) finalizeBuffer failed', {
            sessionKey,
            messageId: exp.id,
            err: errorMessage(err),
          });
        }
      }
    } catch (err) {
      handle.logger.warn('Path D scheduleReconcileForSession failed', {
        sessionKey,
        err: errorMessage(err),
      });
    }
  })();
}

/**
 * P3 Path D — GET /conversations/:id reconcile. Same shape as the session
 * variant, but filtered by `conversationId` so loading a single historical
 * conversation only touches its own expired buffers (not the whole session's).
 *
 * The scope condition is pushed into SQL before limit; otherwise other
 * sessions' older expired buffers can occupy the global batch and starve the
 * current conversation.
 */
export function scheduleReconcileForConversation(
  conversationId: number,
  handle: BootstrapHandle,
): void {
  void (async () => {
    try {
      const expired = handle.repos.conversation.findExpiredBufferedByConversation(
        conversationId,
        PATH_D_GRACE_MS,
        PATH_D_LIMIT,
      );
      const deps = buildFinalizeDeps(handle);
      for (const exp of expired) {
        try {
          await finalizeBuffer(exp.id, deps);
        } catch (err) {
          handle.logger.warn('Path D reconcile (conversation) finalizeBuffer failed', {
            conversationId,
            messageId: exp.id,
            err: errorMessage(err),
          });
        }
      }
    } catch (err) {
      handle.logger.warn('Path D scheduleReconcileForConversation failed', {
        conversationId,
        err: errorMessage(err),
      });
    }
  })();
}

/**
 * POST /conversations/buffered/:id/release
 *
 * Forces immediate execution of a buffered_wait message: CAS-flips to
 * consumed, then runs handleInput with `forcedIntent = fallbackIntent` (the
 * intent classifier stored when it decided to wait). Idempotent — racing
 * with the cron tick or another release call results in exactly one
 * execution; losing callers get `executed: false` + `reason:
 * "already_finalized"`.
 *
 * Returns 404 only when the message row does not exist at all. Any other
 * non-buffered_wait status (already consumed / sent) falls through to the
 * finalizeBuffer CAS path and reports `already_finalized`.
 */
export async function handleBufferedRelease(ctx: RouteContext, messageId: number): Promise<void> {
  const { handle } = ctx;
  const message = handle.repos.conversation.getMessageById(messageId);
  if (!message) {
    respondError(ctx.res, 404, 'not_found', 'Buffered message not found');
    return;
  }
  if (message.sessionKey !== WEB_SESSION_KEY) {
    respondError(ctx.res, 403, 'forbidden_cross_channel', 'cannot use non-web buffered message');
    return;
  }
  if (message.conversationArchivedAt !== null) {
    respondError(ctx.res, 409, 'conversation_archived', 'conversation is archived');
    return;
  }

  // Use the shared HandleInputRepos subset builder so this handler and the
  // Path D schedulers below cannot drift on which repos are passed through.
  const result = await finalizeBuffer(messageId, buildFinalizeDeps(handle));

  if (!result) {
    // CAS lost — message wasn't in buffered_wait (already consumed by cron /
    // another release call / archive). 200 + executed:false so callers can
    // refresh their UI without a retry storm.
    respond(ctx.res, 200, { executed: false, reason: 'already_finalized' });
    return;
  }
  if (!result.result) {
    respond(ctx.res, 200, {
      executed: result.executed,
      result: null,
      conversationId: result.conversationId,
    });
    return;
  }

  const { responseBody } = serializeHandleInputResult(result.result);
  respond(ctx.res, 200, {
    executed: result.executed,
    result: responseBody,
    conversationId: result.conversationId,
  });
}

/**
 * POST /conversations/buffered/:id/cancel
 *
 * Explicit user-initiated discard. CAS-flips the message to consumed but
 * does NOT run handleInput and does NOT write an assistant turn — the
 * intent here is "throw it away", not "execute the fallback intent". UI
 * should hide the message from the active-buffered list after a 200.
 *
 * Idempotent for the same reason as release: a losing CAS just returns
 * `cancelled: false` + `already_finalized`.
 */
export async function handleBufferedCancel(ctx: RouteContext, messageId: number): Promise<void> {
  const { handle } = ctx;
  const message = handle.repos.conversation.getMessageById(messageId);
  if (!message) {
    respond(ctx.res, 200, { cancelled: false, reason: 'already_finalized' });
    return;
  }
  if (message.sessionKey !== WEB_SESSION_KEY) {
    respondError(ctx.res, 403, 'forbidden_cross_channel', 'cannot use non-web buffered message');
    return;
  }
  if (message.conversationArchivedAt !== null) {
    respondError(ctx.res, 409, 'conversation_archived', 'conversation is archived');
    return;
  }
  const consumed = handle.repos.conversation.consumeBuffered(messageId);
  if (!consumed) {
    respond(ctx.res, 200, { cancelled: false, reason: 'already_finalized' });
    return;
  }
  respond(ctx.res, 200, { cancelled: true, conversationId: consumed.conversationId });
}
