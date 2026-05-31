import type { ConversationMessage } from '../../../conversation/types';

/**
 * 从 recentMessages 收集所有曾出现过的 sourceId（无论是 submit accepted
 * 还是 duplicate 都视为"用户已知存在的 source"）。intent-note /
 * intent-tracking 在收到 classifier 的 linkedSourceId 时，必须用这个 Set
 * 校验该 sourceId ∈ 用户最近上下文，防止 LLM hallucinate 一个数字 ID
 * 跨 conversation 串到无关 source。
 */
export function collectMentionedSourceIds(
  recentMessages: ConversationMessage[] | undefined,
): Set<number> {
  const set = new Set<number>();
  if (!recentMessages) return set;
  for (const msg of recentMessages) {
    const meta = msg.metadata;
    if (!meta) continue;
    if (typeof meta.sourceId === 'number') set.add(meta.sourceId);
    if (typeof meta.existingSourceId === 'number') set.add(meta.existingSourceId);
  }
  return set;
}
