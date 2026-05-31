import type { CitedEntity } from '@goldpan/web-sdk';
import type { ChatMessage } from './chat-view';
import { MessageBubble } from './message-bubble';

interface MessageListProps {
  messages: ChatMessage[];
  onEntitySelect: (entity: CitedEntity) => void;
  /** P3: forwarded straight to each MessageBubble; only buffered_wait user
   * bubbles read it (via BufferedWaitIndicator). */
  onReleaseBuffered?: (messageId: number) => void;
  /** P3: forwarded straight to each MessageBubble (BufferedWaitIndicator
   * "取消" button). */
  onCancelBuffered?: (messageId: number) => void;
  /** P4: clarify chip click handler — chat-view 分发到 forcedIntent /input
   * 或 resolveTrackingClarify。MessageList 负责按 message.id 反查 originalUserContent
   * 后再透传，因为 forcedIntent 路径必须把"原 user turn 文本"作为 /input.input
   * 重发一次（plugin 拿到 forcedIntent 后跳过 classifier，但仍需要原始文本
   * 进入 plugin handler 的上下文）。 */
  onClarifyChipClick?: (intentKey: string, payload?: string, originalUserContent?: string) => void;
  /** P5 Task 10: ReclassifyChipBar 点击回调。chat-view 用 useReclassifyNote
   * hook 内部完成 archive + dispatch，这里只透传到每个 MessageBubble；只有
   * resultType === 'note' 的 assistant bubble 才会真正用到。 */
  onReclassify?: (params: {
    noteId: number;
    originalContent: string;
    targetIntentKey: string;
  }) => void;
  /** P5 Task 10: hook `isReclassifying` 透传 — disable chips 防 double-click。 */
  reclassifyDisabled?: boolean;
  /** P5 Fix Batch 5 (I3): per-session 集合 — 收录本会话已经 reclassify 过的
   * noteId。若 note bubble 命中其中任一 id，MessageBubble 不再渲染 ChipBar，
   * 改显"已重新分类"提示，杜绝重复纠错。 */
  reclassifiedNoteIds?: Set<number>;
}

/**
 * P4: 在 messages 数组里反查 clarify card 之前最近的 user turn 的 content。
 * 与 chat-view 顶部同名 helper 同语义 —— 这里 inline 一份避免 MessageList
 * 强依赖 chat-view 的导出（chat-view 已经依赖 MessageList，反向 import 会成环）。
 */
function findOriginalUserContent(
  messages: ChatMessage[],
  clarifyMessageId: string,
): string | undefined {
  const idx = messages.findIndex((m) => m.id === clarifyMessageId);
  if (idx <= 0) return undefined;
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i]?.content;
  }
  return undefined;
}

function trackingRuleIdFromClarify(message: ChatMessage): number | undefined {
  const option = message.clarifyResult?.structuredOptions?.find(
    (opt) => opt.intentKey === 'resolve_tracking_entity' && opt.payload,
  );
  if (!option?.payload) return undefined;
  try {
    const parsed = JSON.parse(option.payload) as { trackingRuleId?: unknown };
    return typeof parsed.trackingRuleId === 'number' ? parsed.trackingRuleId : undefined;
  } catch {
    return undefined;
  }
}

function collectResolvedTrackingRuleIds(messages: ChatMessage[]): Set<number> {
  const ids = new Set<number>();
  for (const msg of messages) {
    const id = msg.metadata?.trackingRuleId;
    if (msg.role === 'assistant' && msg.resultType === 'action' && typeof id === 'number') {
      ids.add(id);
    }
  }
  return ids;
}

export function MessageList({
  messages,
  onEntitySelect,
  onReleaseBuffered,
  onCancelBuffered,
  onClarifyChipClick,
  onReclassify,
  reclassifyDisabled,
  reclassifiedNoteIds,
}: MessageListProps) {
  const resolvedTrackingRuleIds = collectResolvedTrackingRuleIds(messages);

  return (
    <div className="gp-chat__message-list" role="log" aria-live="polite">
      {messages.map((msg) => {
        const clarifyTrackingRuleId =
          msg.role === 'assistant' && msg.resultType === 'clarify'
            ? trackingRuleIdFromClarify(msg)
            : undefined;
        const clarifyDisabled =
          clarifyTrackingRuleId !== undefined && resolvedTrackingRuleIds.has(clarifyTrackingRuleId);
        // Per-message closure bakes originalUserContent into the chip click
        // path so ClarifyResultCard / ClarifyChip 只需要 (intentKey, payload)
        // 两参数；clarify message 与其原 user turn 的绑定全在 MessageList 内完成。
        const onChipClick =
          onClarifyChipClick && msg.role === 'assistant' && msg.resultType === 'clarify'
            ? (intentKey: string, payload?: string) =>
                onClarifyChipClick(intentKey, payload, findOriginalUserContent(messages, msg.id))
            : undefined;
        // P5 Fix Batch 5 (I3): 把"本会话已 reclassify 过的 noteId 集合"折叠成
        // 单个 boolean 传给 MessageBubble — bubble 内部不需要知道整个 set，只
        // 需要知道当前这条要不要切到"已重新分类"提示。
        const isReclassified =
          msg.role === 'assistant' &&
          msg.resultType === 'note' &&
          msg.noteResult !== undefined &&
          (reclassifiedNoteIds?.has(msg.noteResult.noteId) ?? false);
        return (
          <MessageBubble
            key={msg.id}
            message={msg}
            onEntitySelect={onEntitySelect}
            onReleaseBuffered={onReleaseBuffered}
            onCancelBuffered={onCancelBuffered}
            onClarifyChipClick={onChipClick}
            clarifyDisabled={clarifyDisabled}
            onReclassify={onReclassify}
            reclassifyDisabled={reclassifyDisabled}
            isReclassified={isReclassified}
          />
        );
      })}
    </div>
  );
}
