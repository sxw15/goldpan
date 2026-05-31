'use client';

import type { CitedEntity } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { ActionResultCard } from './action-result-card';
import { BufferedWaitIndicator } from './buffered-wait-indicator';
import type { ChatMessage } from './chat-view';
import { ClarifyResultCard } from './clarify-result-card';
import { ContentResultCard } from './content-result-card';
import { DuplicateBubbleCard } from './duplicate-bubble-card';
import { NoteBubbleCard } from './note-bubble-card';
import { QueryResultCard } from './query-result-card';
import { ReclassifyChipBar } from './reclassify-chip-bar';
import { SubmitResultCard } from './submit-result-card';
import { TaskBubbleCard } from './task-bubble-card';

/**
 * P5: trivial inline helper so the case 'note' card reads cleanly. The
 * lookup logic is centralized on `ChatMessage.originalUserContent`, which
 * is populated at convert time (reload path) or in the live runIntent
 * handler — MessageBubble doesn't reverse-walk the array at render time.
 */
function findOriginalUserContent(message: ChatMessage): string | undefined {
  return message.originalUserContent;
}

export function MessageBubble({
  message,
  onEntitySelect,
  onReleaseBuffered,
  onCancelBuffered,
  onClarifyChipClick,
  onReclassify,
  clarifyDisabled,
  reclassifyDisabled,
  isReclassified,
}: {
  message: ChatMessage;
  onEntitySelect: (entity: CitedEntity) => void;
  /** P3: invoked when user clicks "立即执行" inside BufferedWaitIndicator, OR
   * when the indicator's auto-release timer fires 500ms before expiresAt.
   * Receives the server-side numeric message id. */
  onReleaseBuffered?: (messageId: number) => void;
  /** P3: invoked when user clicks "取消" inside BufferedWaitIndicator. */
  onCancelBuffered?: (messageId: number) => void;
  /** P4: invoked when user clicks a ClarifyChip — already pre-bound by
   * MessageList with the relevant `originalUserContent`. */
  onClarifyChipClick?: (intentKey: string, payload?: string) => void;
  /** P5: invoked when user picks a different intent from the
   * ReclassifyChipBar (case 'note'). Task 10 wires this through chat-view's
   * `useReclassifyNote` hook which performs archive + dispatch + rollback. */
  onReclassify?: (params: {
    noteId: number;
    originalContent: string;
    targetIntentKey: string;
  }) => void;
  clarifyDisabled?: boolean;
  /** P5 Task 10: `useReclassifyNote.isReclassifying` — disables chips while
   * the archive + dispatch round-trip is in flight. */
  reclassifyDisabled?: boolean;
  /** P5 Fix Batch 5 (I3): MessageList 折叠后传入 — 该 note 已经在本会话内被
   * reclassify 过，跳过 ChipBar 改显"已重新分类"placeholder，杜绝重复纠错。 */
  isReclassified?: boolean;
}) {
  const t = useTranslations('chat');

  if (message.pending) {
    return (
      <div className="gp-bubble gp-bubble--assistant">
        <span className="gp-bubble__avatar" aria-hidden>
          G
        </span>
        <div className="gp-bubble__content gp-bubble__pending">
          <span className="gp-bubble__thinking">{t('thinking')}</span>
        </div>
      </div>
    );
  }

  if (message.role === 'user') {
    // P3 buffer mechanism: classifier 判定为 buffered_wait 时在气泡下方挂
    // indicator（倒计时 + 立即执行 + 取消）。consumed 显示一个 badge 让用户
    // 能区分"已处理"消息。dbMessageId 必须有值 —— optimistic msg-prefixed
    // 消息 (尚未持久化) 不会进入这个分支，所以这里只渲染 db-prefixed 路径。
    const isBufferedWait =
      message.status === 'buffered_wait' &&
      message.bufferedExpiresAt !== undefined &&
      message.dbMessageId !== undefined;
    // waitReasonKey 走 server metadata 透传：Task 1 step 4.5 把它写到
    // `metadata.waitReasonKey` 顶层；web-sdk ConversationMessage.metadata 是
    // Record<string, unknown> | null —— 这里 type 已通过 ChatMessage.metadata 透传，
    // 但 value 仍是 unknown，所以保留窄化 cast。
    const waitReasonKey =
      (message.metadata?.waitReasonKey as string | undefined) ?? 'awaiting_clarification';
    return (
      <div className="gp-bubble gp-bubble--user">
        <div className="gp-bubble__content">{message.content}</div>
        {isBufferedWait && (
          <BufferedWaitIndicator
            messageId={message.dbMessageId as number}
            expiresAt={message.bufferedExpiresAt as number}
            waitReasonKey={waitReasonKey}
            onRelease={onReleaseBuffered ?? (() => {})}
            onCancel={onCancelBuffered ?? (() => {})}
          />
        )}
        {message.status === 'consumed' && (
          <div className="gp-bubble__consumed-badge">{t('consumed_badge')}</div>
        )}
      </div>
    );
  }

  // Duplicate submissions get a rich card with deep-link buttons to the
  // original task and the library. Same wrapper-skipping pattern as the
  // accepted-task card so the bubble shell doesn't double-border.
  if (
    message.resultType === 'submit' &&
    message.submitResult?.status === 'duplicate' &&
    typeof message.submitResult.existingSourceId === 'number'
  ) {
    return (
      <div className="gp-bubble gp-bubble--assistant">
        <span className="gp-bubble__avatar" aria-hidden>
          G
        </span>
        <DuplicateBubbleCard
          existingTaskId={message.submitResult.existingTaskId ?? null}
          existingSourceId={message.submitResult.existingSourceId}
          existingUrl={message.submitResult.existingUrl}
        />
      </div>
    );
  }

  // Accepted submissions get a rich, polling-driven task card that replaces
  // the regular bubble content wrapper (the card supplies its own surface +
  // border so the visuals don't double-up). Rejected submissions fall through
  // to the inline SubmitResultCard.
  if (
    message.resultType === 'submit' &&
    message.submitResult?.status === 'accepted' &&
    message.submitResult.taskId
  ) {
    const taskIdNum = Number(message.submitResult.taskId);
    if (Number.isFinite(taskIdNum) && taskIdNum > 0) {
      // Opinion submissions (record_thought intent) get a quote-style note
      // card; neutral fact text/URL submissions keep the pipeline-strip task
      // card. Both share the underlying polling + retry machinery.
      if (message.submitResult.inputMode === 'opinion') {
        return (
          <div className="gp-bubble gp-bubble--assistant">
            <span className="gp-bubble__avatar" aria-hidden>
              G
            </span>
            <NoteBubbleCard taskId={taskIdNum} />
          </div>
        );
      }
      // Fresh submissions (id prefix `msg-`) default-expand so users see the
      // pipeline progress + result right away. Reloaded conversations
      // (id prefix `db-`) stay collapsed — the user opted into reviewing
      // history, not into auto-replaying every task body.
      const isFresh = message.id.startsWith('msg-');
      return (
        <div className="gp-bubble gp-bubble--assistant">
          <span className="gp-bubble__avatar" aria-hidden>
            G
          </span>
          <TaskBubbleCard taskId={taskIdNum} defaultOpen={isFresh} />
        </div>
      );
    }
  }

  // Assistant bubble — dispatch by resultType to avoid a growing mutual-exclusion chain
  let card: React.ReactNode = null;
  switch (message.resultType) {
    case 'query':
      if (message.queryResult)
        card = <QueryResultCard result={message.queryResult} onEntitySelect={onEntitySelect} />;
      break;
    case 'submit':
      if (message.submitResult) card = <SubmitResultCard result={message.submitResult} />;
      break;
    case 'content':
      if (message.contentResult) card = <ContentResultCard result={message.contentResult} />;
      break;
    case 'action':
      if (message.actionResult) card = <ActionResultCard result={message.actionResult} />;
      break;
    case 'clarify':
      if (message.clarifyResult)
        card = (
          <ClarifyResultCard
            result={message.clarifyResult}
            onChipClick={onClarifyChipClick ?? (() => {})}
            disabled={clarifyDisabled}
          />
        );
      break;
    case 'note':
      // P5: server `intent-note` plugin returned a `type: 'note'` result.
      // ReclassifyChipBar (N5) lets the user pick a different intent if the
      // classifier read the input wrong. Task 10 wires the dispatch through
      // chat-view's `useReclassifyNote` hook (archive + /input forcedIntent
      // + rollback); `reclassifyDisabled` mirrors the hook's `isReclassifying`
      // flag to block double-clicks during the round-trip.
      // P5 Fix Batch 5 (I3): 若该 note 已经在本会话内被 reclassify 过，跳过
      // ChipBar 改显纯文字 placeholder — server-side 不改 conversation_messages
      // 行，reload 仍会把 noteId 还原成 note bubble，但 ChipBar 再点会因 note
      // 已 archived 报错，所以这里直接屏蔽。
      if (message.noteResult) {
        if (isReclassified) {
          card = <p className="gp-message-bubble__reclassified-hint">{t('reclassified_note')}</p>;
        } else {
          card = (
            <ReclassifyChipBar
              noteId={message.noteResult.noteId}
              subtype={message.noteResult.subtype}
              originalContent={findOriginalUserContent(message) ?? ''}
              onReclassify={onReclassify ?? (() => {})}
              disabled={reclassifyDisabled}
            />
          );
        }
      }
      break;
    case 'error':
      card = (
        <div className="gp-bubble__error">
          <span>{message.content || t('intent_error')}</span>
        </div>
      );
      break;
    case undefined:
      break;
    default: {
      const _exhaustive: never = message.resultType;
      void _exhaustive;
    }
  }

  return (
    <div className="gp-bubble gp-bubble--assistant">
      <span className="gp-bubble__avatar" aria-hidden>
        G
      </span>
      <div className="gp-bubble__content">{card ?? <span>{message.content}</span>}</div>
    </div>
  );
}
