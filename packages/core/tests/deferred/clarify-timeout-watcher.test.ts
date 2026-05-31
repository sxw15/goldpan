import type { ILogObj, Logger } from 'tslog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startClarifyTimeoutWatcher } from '../../src/deferred/clarify-timeout-watcher';

function silentLogger(): Logger<ILogObj> {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger<ILogObj>;
}

describe('startClarifyTimeoutWatcher', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    if (stop) {
      stop();
      stop = null;
    }
    vi.useRealTimers();
  });

  it('每 tick 扫 awaiting_clarify > cutoff → markFailedResolution(failed_no_entity)', async () => {
    vi.useFakeTimers();
    const port = {
      findAwaitingClarifyOlderThan: vi.fn().mockReturnValue([
        {
          id: 5,
          pendingResolution: { sourceId: 1, conversationId: 1, candidateEntityIds: [1, 2] },
        },
      ]),
      markFailedResolution: vi.fn().mockReturnValue(true),
    } as never;
    const pushAssistant = vi.fn();

    stop = startClarifyTimeoutWatcher({
      port,
      intervalMs: 1000,
      timeoutHours: 24,
      logger: silentLogger(),
      pushAssistant,
    });
    await vi.advanceTimersByTimeAsync(1100);

    expect(port.findAwaitingClarifyOlderThan).toHaveBeenCalledWith(expect.any(Number));
    expect(port.markFailedResolution).toHaveBeenCalledWith(5, {
      targetStatus: 'failed_no_entity',
      expectedStatus: 'awaiting_clarify',
    });
    expect(pushAssistant).toHaveBeenCalled();
  });

  it('GOLDPAN_DISABLE_CLARIFY_TIMEOUT_WATCHER=true → 不启动', () => {
    process.env.GOLDPAN_DISABLE_CLARIFY_TIMEOUT_WATCHER = 'true';
    const port = {
      findAwaitingClarifyOlderThan: vi.fn(),
      markFailedResolution: vi.fn(),
    } as never;
    stop = startClarifyTimeoutWatcher({
      port,
      intervalMs: 1000,
      timeoutHours: 24,
      logger: silentLogger(),
      pushAssistant: vi.fn(),
    });
    stop();
    delete process.env.GOLDPAN_DISABLE_CLARIFY_TIMEOUT_WATCHER;
    expect(port.findAwaitingClarifyOlderThan).not.toHaveBeenCalled();
  });
});
