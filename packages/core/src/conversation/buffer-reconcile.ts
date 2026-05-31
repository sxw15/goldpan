import type { ILogObj, Logger } from 'tslog';
import { errorMessage } from '../errors';
import { type FinalizeBufferDeps, finalizeBuffer } from './buffer-finalize';

export interface ReconcileBufferedDeps extends FinalizeBufferDeps {
  /** 5s 默认值与 Path D / 旧 Path C 一致 —— user-initiated 时机的紧 grace */
  graceMs?: number;
  /** 单次扫描最多 finalize 几条，防止同 session 大量 expired 阻塞调用方 */
  limit?: number;
  /** caller 自带的 logger 子 logger；不传则用 deps.logger */
  reconcileLogger?: Logger<ILogObj>;
}

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_LIMIT = 10;

/**
 * P3 Path C — caller 入口处 await 此 helper，保证 fallback assistant turn
 * 在新 user turn 写入之前完成。原 input.ts 内的 fire-and-forget IIFE 与
 * 主路径 classify 竞争 assistant turn 的写入顺序，已废弃。
 *
 * 错误 swallow per-row + 外层 try/catch —— reconcile 失败不应阻断 caller。
 */
export async function reconcileExpiredBufferedBySession(
  sessionKey: string,
  deps: ReconcileBufferedDeps,
): Promise<void> {
  const log = deps.reconcileLogger ?? deps.logger;
  try {
    const expired = deps.repos.conversation.findExpiredBufferedBySession(
      sessionKey,
      deps.graceMs ?? DEFAULT_GRACE_MS,
      deps.limit ?? DEFAULT_LIMIT,
    );
    for (const exp of expired) {
      try {
        await finalizeBuffer(exp.id, deps);
      } catch (err) {
        log.warn('reconcileExpiredBufferedBySession: finalize failed', {
          sessionKey,
          messageId: exp.id,
          err: errorMessage(err),
        });
      }
    }
  } catch (err) {
    log.warn('reconcileExpiredBufferedBySession: scan failed', {
      sessionKey,
      err: errorMessage(err),
    });
  }
}
