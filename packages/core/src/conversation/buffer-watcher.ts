import type { ILogObj, Logger } from 'tslog';
import type { DrizzleDB } from '../db/connection';
import type { ConversationRepository } from '../db/repositories/types';
import { errorMessage } from '../errors';

export interface BufferWatcherDeps {
  db: DrizzleDB;
  repo: ConversationRepository;
  /** 默认 300000 (5 min)，spec §"buffer expiration" E 路推荐值 */
  intervalMs: number;
  /** Client 倒计时 vs server 时钟漂移容忍，默认 30000 (30s) */
  graceMs: number;
  /** 每 tick 处理的最大 buffer 数 */
  batchSize: number;
  logger: Logger<ILogObj>;
  /** 注入 finalize 函数，测试 mock；生产传入 (id) => finalizeBuffer(id, { ... }) */
  finalize: (messageId: number) => Promise<unknown>;
}

/**
 * Path E：后台 cron 兜底"用户彻底没回来"的场景。
 *
 * 用 recursive setTimeout 自循环（与 worker.ts 同模式），不用 setInterval —
 * 避免 finalize 慢时多个 tick 重叠。
 *
 * 通过 `GOLDPAN_DISABLE_BUFFER_WATCHER=true` 可关闭（测试 / 调试）。
 */
export function startBufferWatcher(deps: BufferWatcherDeps): () => void {
  if (process.env.GOLDPAN_DISABLE_BUFFER_WATCHER === 'true') {
    deps.logger.info('bufferWatcher disabled by env');
    return () => {};
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const expired = deps.repo.findExpiredBuffered(deps.graceMs, deps.batchSize);
      if (expired.length > 0) {
        deps.logger.info('bufferWatcher: finalizing expired buffers', {
          count: expired.length,
        });
      }
      for (const exp of expired) {
        if (stopped) return;
        try {
          await deps.finalize(exp.id);
        } catch (err) {
          deps.logger.error('bufferWatcher: finalize failed', {
            messageId: exp.id,
            err: errorMessage(err),
          });
        }
      }
    } catch (err) {
      deps.logger.error('bufferWatcher: tick scan failed', { err: errorMessage(err) });
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, deps.intervalMs);
      }
    }
  }

  // 首 tick 延迟一个 interval 启动（避免 bootstrap 期间高负载）
  timer = setTimeout(tick, deps.intervalMs);

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
