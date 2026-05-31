import type { ConversationRepository } from '../db/repositories/types';

export interface MergeBufferedDeps {
  repo: ConversationRepository;
}

export interface MergeResult {
  /** 合并后传给 handleInput 的 input 字符串 */
  input: string;
  /** 是否真的合并了（false 表示 newInput 原样返回） */
  merged: boolean;
  /** 被消费掉的原 buffered message id（merged=true 时设） */
  previousMessageId?: number;
}

/**
 * Path A：在 adapter 入口（appendMessage 之前）调。
 *
 * B5 修复：consume **所有** active buffered（oldest-first），不再只 LIMIT 1。
 * 防并发场景下旧 buffered 孤立 —— web `/input` 无 per-session FIFO 锁，
 * 同 sessionKey 两条 POST 都成功 markBufferedWait 时，老的会被 LIMIT 1
 * 漏掉、等 Path E cron 才被 finalize。
 *
 * 合并顺序：[oldest_buf, ..., newest_buf, newInput]，空行分隔。
 *
 * 幂等：CAS 失败 / 无 buffer / expired 都安全降级为 newInput 原样。
 */
export function findAndMergeBuffered(
  sessionKey: string,
  newInput: string,
  deps: MergeBufferedDeps,
): MergeResult {
  const all = deps.repo.findAllActiveBufferedBySession(sessionKey);
  if (all.length === 0) {
    return { input: newInput, merged: false };
  }

  const parts: string[] = [];
  let lastConsumedId: number | undefined;
  for (const buf of all) {
    const consumed = deps.repo.consumeBuffered(buf.id);
    if (consumed) {
      parts.push(consumed.content);
      lastConsumedId = buf.id;
    }
    // CAS 失败的 buffer 被并发路径 finalize 了，跳过即可。
  }

  if (parts.length === 0) {
    return { input: newInput, merged: false };
  }

  parts.push(newInput);
  return {
    input: parts.join('\n\n'),
    merged: true,
    previousMessageId: lastConsumedId,
  };
}
