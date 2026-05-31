import type { ILogObj, Logger } from 'tslog';
import { errorMessage } from '../errors';
import { t } from '../i18n/index';
import type { DeferredTrackingPort, PendingResolutionPayload } from './types';

export interface ClarifyTimeoutWatcherDeps {
  port: Pick<DeferredTrackingPort, 'findAwaitingClarifyOlderThan' | 'markFailedResolution'>;
  intervalMs: number;
  timeoutHours: number;
  logger: Logger<ILogObj>;
  /** Bootstrap 注入：写 conversation_messages + 可选 IM outbound。recursive setTimeout
   * 自循环里只发 action message（reminder），不发 clarify。
   * B11 修复：加 ruleId 参数 —— bootstrap 用它构造与 deferred/resolver 一致的
   * `tracking-{ruleId}-...` actionId，extractAssistantTurn 出来的 metadata
   * 就和正常 deferred push 同 shape (resultType + trackingRuleId)。 */
  pushAssistant: (payload: PendingResolutionPayload, message: string, ruleId: number) => void;
}

/**
 * awaiting_clarify 的 tracking rule 超过 timeoutHours（24h spec）没响应 →
 * 标 failed_no_entity + push reminder。recursive setTimeout 自循环（与
 * buffer-watcher 同模式，避免 setInterval 下 tick 慢时重叠）。
 *
 * `GOLDPAN_DISABLE_CLARIFY_TIMEOUT_WATCHER=true` 关闭。
 */
export function startClarifyTimeoutWatcher(deps: ClarifyTimeoutWatcherDeps): () => void {
  if (process.env.GOLDPAN_DISABLE_CLARIFY_TIMEOUT_WATCHER === 'true') {
    deps.logger.info('clarifyTimeoutWatcher disabled by env');
    return () => {};
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const cutoff = Date.now() - deps.timeoutHours * 3600_000;
      const expired = deps.port.findAwaitingClarifyOlderThan(cutoff);
      if (expired.length > 0) {
        deps.logger.info('clarifyTimeoutWatcher: timing out awaiting_clarify', {
          count: expired.length,
          cutoff,
        });
      }
      for (const rule of expired) {
        if (stopped) return;
        try {
          const ok = deps.port.markFailedResolution(rule.id, {
            targetStatus: 'failed_no_entity',
            expectedStatus: 'awaiting_clarify',
          });
          if (ok && rule.pendingResolution) {
            deps.pushAssistant(
              rule.pendingResolution,
              t('tracking.awaiting_clarify_timeout_assistant_text'),
              rule.id,
            );
          }
        } catch (err) {
          deps.logger.error('clarifyTimeoutWatcher: rule transition failed', {
            ruleId: rule.id,
            err: errorMessage(err),
          });
        }
      }
    } catch (err) {
      deps.logger.error('clarifyTimeoutWatcher: tick failed', { err: errorMessage(err) });
    } finally {
      if (!stopped) timer = setTimeout(tick, deps.intervalMs);
    }
  }

  timer = setTimeout(tick, deps.intervalMs);
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
