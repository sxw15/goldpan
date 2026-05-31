'use server';

import type { CitedEntity, InputSubmitResult } from '@goldpan/web-sdk';
import { GoldpanApiError } from '@goldpan/web-sdk';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createServerClient, rethrowNextErrors } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { mapRejectCodeToText } from '@/lib/reject-code-i18n';

// Conservative fallback when ChatView fails to forward the configured limit;
// keeps error toasts renderable without reaching for a stale env var.
const FALLBACK_MAX_INPUT_LENGTH = 20000;

/**
 * Server-side error codes that mean "the conversation referenced by this
 * input no longer accepts writes" — deleted, archived, or cross-channel.
 * We redirect home and surface a notice via ?deleted=1 so the user can't keep
 * typing into a dead session.
 */
const STALE_CONVERSATION_CODES = new Set([
  'conversation_not_found',
  'conversation_archived',
  'forbidden_cross_channel',
]);

export type InputActionState = {
  type?: 'submit' | 'query' | 'content' | 'action' | 'clarify' | 'wait' | 'error' | 'note';
  // submit results
  status?: 'accepted' | 'duplicate' | 'rejected';
  taskId?: string;
  reason?: string;
  warnings?: string[];
  /** P5: server `intent-note` plugin result. Drives MessageBubble case 'note'
   * which renders ReclassifyChipBar (N5 transparent classification correction).
   * P4-era `case 'note'` squashed into `type: 'action'` losing the hook needed
   * for N5. Tracking_pending stays squashed (no reclassify need). */
  noteId?: number;
  noteSubtype?: 'memo' | 'note';
  /** Duplicate-only: original task id + URL so the duplicate bubble can deep
   * link instead of falling back to plain text. `existingTaskId` may be `null`
   * if the original task was deleted but the source row remains. */
  existingTaskId?: number | null;
  existingSourceId?: number;
  existingUrl?: string;
  /** Drives whether ChatView renders TaskBubbleCard or NoteBubbleCard for an
   * accepted submit. Only present on opinion submissions (server omits it for
   * neutral fact text/URL submissions, which default to TaskBubbleCard). */
  inputMode?: 'fact' | 'opinion';
  // query results
  answer?: string;
  confidence?: 'high' | 'medium' | 'low' | 'no_data';
  citedEntityIds?: number[];
  citedPointIds?: number[];
  citedEntities?: CitedEntity[];
  originalQuery?: string;
  // content results
  contentText?: string;
  contentFormat?: 'text' | 'markdown';
  contentTitle?: string;
  // action results
  actionMessage?: string;
  actionId?: string;
  // clarify results
  clarifyQuestion?: string;
  clarifyOptions?: string[];
  /** P4: keyed clarify (P2 shape) — classifier 路径 + deferred resolver 都用
   * 这两个字段；UI 优先消费走 i18n，回退 `clarifyQuestion`/`clarifyOptions`。 */
  clarifyQuestionKey?: string;
  clarifyStructuredOptions?: Array<{ intentKey: string; payload?: string }>;
  // wait results
  bufferedMessageId?: number;
  bufferedExpiresAt?: number;
  fallbackIntent?: string;
  maxWaitMs?: number;
  waitReasonKey?: string;
  // Server-returned conversation id (S7+S8) — used by ChatView to sync URL.
  conversationId?: number;
};

function mapSubmitResult(
  sr: InputSubmitResult,
  t: Awaited<ReturnType<typeof getTranslations>>,
  maxInputLength: number,
): InputActionState {
  switch (sr.status) {
    case 'accepted':
      return {
        type: 'submit',
        status: 'accepted',
        taskId: sr.taskId != null ? String(sr.taskId) : undefined,
        warnings: sr.warnings,
        ...(sr.inputMode !== undefined && { inputMode: sr.inputMode }),
      };
    case 'duplicate':
      return {
        type: 'submit',
        status: 'duplicate',
        reason: t('url_duplicate'),
        existingTaskId: sr.existingTaskId,
        existingSourceId: sr.existingSourceId,
        existingUrl: sr.existingUrl,
      };
    case 'rejected':
      return {
        type: 'submit',
        status: 'rejected',
        reason: mapRejectCodeToText(sr.code, t, maxInputLength) ?? t('submit_failed'),
      };
    default:
      return { type: 'submit', status: 'rejected', reason: t('submit_failed') };
  }
}

function mapApiError(
  err: GoldpanApiError,
  t: Awaited<ReturnType<typeof getTranslations>>,
  maxInputLength: number,
): InputActionState {
  const codeToI18n: Record<string, () => string> = {
    input_empty: () => t('input_required'),
    text_too_long: () => t('input_too_long', { limit: maxInputLength }),
    query_too_long: () => t('input_too_long_for_intent'),
    input_too_long_for_intent: () => t('input_too_long_for_intent'),
    intent_failed: () => t('intent_failed'),
    query_failed: () => t('query_failed'),
    submit_failed: () => t('submit_failed'),
    unknown_intent: () => t('unknown_intent'),
    plugin_error: () => t('plugin_error'),
    rate_limited: () => t('submit_rate_limited'),
  };
  const mapFn = codeToI18n[err.code];
  return { type: 'error', reason: mapFn ? mapFn() : t('submit_failed') };
}

export async function inputAction(
  _prevState: InputActionState,
  formData: FormData,
): Promise<InputActionState> {
  await requireAuth();
  const t = await getTranslations('actions');

  const rawInput = formData.get('input');
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    return { type: 'error', reason: t('input_required') };
  }

  const conversationIdRaw = formData.get('conversationId');
  const conversationIdValue =
    typeof conversationIdRaw === 'string' && conversationIdRaw !== ''
      ? Number(conversationIdRaw)
      : Number.NaN;
  const conversationId =
    Number.isInteger(conversationIdValue) && conversationIdValue > 0
      ? conversationIdValue
      : undefined;
  const sessionKeyRaw = formData.get('sessionKey');
  const sessionKey =
    typeof sessionKeyRaw === 'string' && sessionKeyRaw !== '' ? sessionKeyRaw : undefined;

  // P4: chip click handler 通过 formData 把 clarify candidate 的 intentKey +
  // payload 一起送回来 —— server /input 跳过 LLM classifier，直接走 forcedIntent
  // 路径让 plugin 拿 payload 完成任务 (e.g. resolve_tracking_entity)。
  // 两者在 API surface 必须成对存在但允许 forcedIntent 单独出现 (IM bound-intent)；
  // payload 单独出现没意义（free-text 路径 plugin 拿不到 chip 的 intent 上下文），
  // 但这里不做这层校验 —— 让 server respondError 兜底，避免双层 validation drift。
  const forcedIntentRaw = formData.get('forcedIntent');
  const forcedIntent =
    typeof forcedIntentRaw === 'string' && forcedIntentRaw.trim() ? forcedIntentRaw : undefined;
  const payloadRaw = formData.get('payload');
  const payload = typeof payloadRaw === 'string' ? payloadRaw : undefined;

  // Forwarded by ChatView so error toasts quote the same number that /input enforces
  // (web app and goldpan-server are separate processes; their env loaders can diverge).
  const maxInputLengthRaw = formData.get('maxInputLength');
  const maxInputLengthNum =
    typeof maxInputLengthRaw === 'string' ? Number(maxInputLengthRaw) : Number.NaN;
  const maxInputLength =
    Number.isInteger(maxInputLengthNum) && maxInputLengthNum > 0
      ? maxInputLengthNum
      : FALLBACK_MAX_INPUT_LENGTH;

  try {
    const client = await createServerClient();
    const result = await client.input({
      input: rawInput,
      ...(conversationId !== undefined && { conversationId }),
      ...(sessionKey !== undefined && { sessionKey }),
      ...(forcedIntent !== undefined && { forcedIntent }),
      ...(payload !== undefined && { payload }),
    });
    const responseConvId = (result as { conversationId?: number }).conversationId;

    switch (result.type) {
      case 'submit':
        return { ...mapSubmitResult(result, t, maxInputLength), conversationId: responseConvId };

      case 'query':
        return {
          type: 'query',
          answer: result.answer,
          confidence: result.confidence,
          citedEntityIds: result.citedEntityIds,
          citedPointIds: result.citedPointIds,
          citedEntities: result.citedEntities ?? [],
          originalQuery: result.query,
          conversationId: responseConvId,
        };

      case 'content':
        return {
          type: 'content',
          contentText: result.text,
          contentFormat: result.format,
          contentTitle: result.title,
          conversationId: responseConvId,
        };

      case 'action':
        return {
          type: 'action',
          actionMessage: result.message,
          actionId: result.actionId,
          conversationId: responseConvId,
        };

      case 'clarify':
        return {
          type: 'clarify',
          clarifyQuestion: result.question,
          clarifyOptions: result.options,
          ...(result.questionKey !== undefined && { clarifyQuestionKey: result.questionKey }),
          ...(result.structuredOptions !== undefined && {
            clarifyStructuredOptions: result.structuredOptions,
          }),
          conversationId: responseConvId,
        };

      case 'wait':
        return {
          type: 'wait',
          bufferedMessageId: result.bufferedMessageId,
          bufferedExpiresAt: result.expiresAt,
          fallbackIntent: result.fallbackIntent,
          maxWaitMs: result.maxWaitMs,
          waitReasonKey: result.waitReasonKey,
          conversationId: responseConvId,
        };

      case 'note':
        // P5: un-squash — return native `type: 'note'` + noteId/subtype so
        // chat-view + MessageBubble can render the ReclassifyChipBar (N5).
        // grep verified `actionId: 'note:...'` was never read downstream.
        return {
          type: 'note',
          noteId: result.note.id,
          noteSubtype: result.note.subtype,
          conversationId: responseConvId,
        };

      case 'tracking_pending':
        return {
          type: 'action',
          actionMessage:
            result.reasonKey === 'waiting_pipeline'
              ? t('tracking_pending_pipeline')
              : t('tracking_pending_multi_entity'),
          actionId: `tracking:${result.trackingRuleId}`,
          conversationId: responseConvId,
        };

      default:
        return { type: 'error', reason: t('submit_failed') };
    }
  } catch (err) {
    rethrowNextErrors(err);
    if (err instanceof GoldpanApiError) {
      if (STALE_CONVERSATION_CODES.has(err.code)) {
        redirect('/?deleted=1');
      }
      const responseConvId =
        typeof err.data?.conversationId === 'number' ? err.data.conversationId : undefined;
      return { ...mapApiError(err, t, maxInputLength), conversationId: responseConvId };
    }
    console.error('[inputAction] failed:', err instanceof Error ? err.message : err);
    return { type: 'error', reason: t('submit_failed') };
  }
}
