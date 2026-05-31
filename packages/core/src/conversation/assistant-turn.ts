// P3 二轮 review：从 im-runtime/src/conversation/store.ts 上浮 ——
// 同一份 "按 result.type 拼 (content, metadata)" 逻辑现在被 IM dispatcher
// (`ConversationStore.appendAssistantTurn`) + P3 buffer-finalize 共用，
// 避免两侧实装漂移。
//
// store.ts 内现在改为 `re-export` 本模块的 extractAssistantTurn —— 旧
// IM-runtime tests 通过 re-export 链继续 byte-for-byte 通过。

import type { ConversationRepository } from '../db/repositories/types';
import { t } from '../i18n/index';
import type { HandleInputResult } from '../input';
import type { SubmitResult } from '../submit';

export interface AssistantTurn {
  content: string;
  metadata: Record<string, unknown>;
}

/**
 * Reduces a `HandleInputResult` (which is `IntentPluginResult | { type: 'error', code, message }`)
 * into the (content, metadata) shape we persist as the assistant's turn in `conversation_messages`.
 *
 * Returns `null` when no assistant turn should be written —— currently only
 * `type='wait'`, whose P2 contract leaves the conversation un-paired and the
 * matching user turn marked `buffered_wait`; the eventual buffer-release path
 * (P3) writes the real assistant reply once the buffered turn merges with a
 * follow-up.
 */
export function extractAssistantTurn(result: HandleInputResult): AssistantTurn | null {
  switch (result.type) {
    case 'content':
      return {
        content: result.text,
        metadata: { resultType: result.type, format: result.format ?? 'text' },
      };
    case 'query':
      return {
        content: result.result.answer,
        metadata: {
          resultType: result.type,
          confidence: result.result.confidence,
          citedEntityIds: result.result.citedEntityIds,
          citedPointIds: result.result.citedPointIds,
        },
      };
    case 'submit': {
      const sr = result.result;
      return {
        content: summarizeSubmit(sr),
        metadata: {
          resultType: result.type,
          submitStatus: sr.status,
          ...(sr.status === 'accepted' && {
            taskId: sr.taskId,
            sourceId: sr.sourceId,
            ...(sr.inputMode !== undefined && { inputMode: sr.inputMode }),
          }),
          ...(sr.status === 'duplicate' && {
            existingSourceId: sr.existingSourceId,
            existingTaskId: sr.existingTaskId,
            existingUrl: sr.existingUrl,
          }),
        },
      };
    }
    case 'action':
      return {
        content: result.message,
        metadata: {
          resultType: result.type,
          ...(result.actionId !== undefined ? { actionId: result.actionId } : {}),
        },
      };
    case 'clarify':
      // P2 加性扩展：`question` 现在是 optional（外部 plugin / classifier 路径
      // 都可能不带）。content 落到 question ?? questionKey ?? '' 作为兜底，
      // metadata 把 keyed + legacy 字段都保留，render 层任选其一渲染。
      return {
        content: result.question ?? result.questionKey ?? '',
        metadata: {
          resultType: result.type,
          ...(result.options !== undefined ? { options: result.options } : {}),
          ...(result.questionKey !== undefined ? { questionKey: result.questionKey } : {}),
          ...(result.structuredOptions !== undefined
            ? { structuredOptions: result.structuredOptions }
            : {}),
        },
      };
    case 'wait':
      // P2: wait 不写 assistant turn —— 缓冲已经在 input.ts 通过
      // markBufferedWait 把 user turn 标成 `buffered_wait`。P3 释放路径再补写。
      // adapter（server /input + im dispatcher）都必须把 null 当作 "skip"
      // 处理，不要降级写空消息，否则会污染 conversation。
      return null;
    case 'note':
      // P2: 走 core t() 渲染人类可读确认文案，metadata 带回 noteId / subtype
      // 供 web UI / IM render 拼笔记气泡。
      return {
        content: t('intent_note.saved_assistant_text', { noteId: result.detail.id }),
        metadata: {
          resultType: result.type,
          noteId: result.detail.id,
          subtype: result.detail.subtype,
        },
      };
    case 'tracking_pending': {
      const key =
        result.reasonKey === 'waiting_pipeline'
          ? 'intent_tracking.pending_pipeline_assistant_text'
          : 'intent_tracking.pending_multi_entity_assistant_text';
      return {
        content: t(key),
        metadata: {
          resultType: result.type,
          trackingRuleId: result.trackingRuleId,
          reasonKey: result.reasonKey,
        },
      };
    }
    case 'error':
      return {
        content: result.message,
        metadata: { resultType: result.type, code: result.code },
      };
  }
}

// Persisted into `conversation_messages.content` and later surfaced back to the LLM
// via conversation context. Numeric source ids stay in metadata (not content), so
// follow-up intent classification can safely reference recently submitted sources
// without leaking raw ids into user-visible message text.
function summarizeSubmit(r: SubmitResult): string {
  switch (r.status) {
    case 'accepted':
      return `accepted — task ${r.taskId}`;
    case 'duplicate':
      return 'duplicate — already submitted';
    case 'rejected':
      return `rejected — ${r.code}: ${r.reason}`;
  }
}

/**
 * 薄 wrapper：调 `extractAssistantTurn` 拿 (content, metadata) → 调
 * `repo.appendMessage` 真正落库。buffer-finalize 用。返 null = 没写
 * （wait 路径）。
 *
 * 不接受 language 参数 —— t() 调用走 core 单例 i18n（initI18n 在 bootstrap
 * 阶段调一次），与 store.appendAssistantTurn 现有行为一致。
 */
export function writeAssistantTurnForResult(params: {
  repo: ConversationRepository;
  conversationId: number;
  result: HandleInputResult;
}): { id: number } | null {
  const turn = extractAssistantTurn(params.result);
  if (turn === null) return null;
  return params.repo.appendMessage(params.conversationId, {
    role: 'assistant',
    content: turn.content,
    metadata: turn.metadata,
  });
}
