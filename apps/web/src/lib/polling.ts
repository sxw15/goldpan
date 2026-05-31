'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEvent } from '@/lib/task-display';
import type { ProcessingResult } from '@/types/processing-result';

export interface TaskLogEntry {
  id: number;
  taskId: number;
  step: string;
  event: LogEvent;
  message: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
  timestamp: number;
}

type TaskStatusResponse =
  | {
      status: 'pending';
      taskId: string;
      sourceId: number;
      createdAt: number;
      sourceStatus?: string | null;
      sourceUrl?: string | null;
      logs?: TaskLogEntry[];
    }
  | {
      status: 'processing';
      taskId: string;
      sourceId: number;
      createdAt: number;
      pipelineStep?: string | null;
      sourceStatus?: string | null;
      sourceUrl?: string | null;
      logs?: TaskLogEntry[];
    }
  | {
      status: 'done';
      taskId: string;
      sourceId: number;
      createdAt: number;
      result: ProcessingResult;
      sourceStatus?: string | null;
      sourceUrl?: string | null;
      logs?: TaskLogEntry[];
    }
  | {
      status: 'error';
      taskId: string;
      sourceId: number;
      createdAt: number;
      error: { step: string; kind: string; message: string; retryable: boolean };
      sourceStatus?: string | null;
      sourceUrl?: string | null;
      logs?: TaskLogEntry[];
    };

export type { TaskStatusResponse };

export type PollingErrorKey =
  | 'session_expired'
  | 'server_error'
  | 'server_error_retrying'
  | 'server_unreachable'
  | 'network_retrying'
  | 'poll_timeout';

interface UseTaskPollingOptions {
  taskId: number;
  enabled?: boolean;
  intervalMs?: number;
  t: (key: PollingErrorKey) => string;
  /** Bump to force the polling loop to restart and re-fetch from scratch.
   * Used after retry: the previous loop has already exited on the terminal
   * `error` status, so without an explicit restart the UI keeps showing the
   * stale failure even though the backend has reset the task to pending. */
  restartKey?: number;
}

interface UseTaskPollingResult {
  data: TaskStatusResponse | null;
  isPolling: boolean;
  error: string | null;
  /** True when the polled task returned 404 — it was deleted (or never
   * existed). Distinct from `error`: deletion is a normal terminal state the
   * user usually caused, so consumers render a neutral "已删除" tombstone
   * rather than the red error styling reserved for transport failures. */
  notFound: boolean;
}

const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_POLL_DURATION_MS = 10 * 60 * 1000; // 10 minutes absolute ceiling

// Field-by-field compare — only checks what drives UI during pending/processing.
// Terminal transitions (done/error) always report "changed" so consumers see
// the new payload. Logs are append-only with monotonic ids; same length +
// same trailing id ⇒ same content (avoids walking long log arrays).
function deepEqualPollResponse(a: TaskStatusResponse, b: TaskStatusResponse): boolean {
  if (a.status !== b.status) return false;
  if (a.taskId !== b.taskId) return false;
  if (a.sourceId !== b.sourceId) return false;
  if (a.sourceUrl !== b.sourceUrl) return false;
  if (a.sourceStatus !== b.sourceStatus) return false;
  const aLogs = a.logs ?? null;
  const bLogs = b.logs ?? null;
  const aLen = aLogs?.length ?? 0;
  const bLen = bLogs?.length ?? 0;
  if (aLen !== bLen) return false;
  if (aLen > 0 && aLogs && bLogs && aLogs[aLen - 1].id !== bLogs[aLen - 1].id) return false;
  if (a.status === 'processing' && b.status === 'processing') {
    return a.pipelineStep === b.pipelineStep;
  }
  if (a.status === 'pending' && b.status === 'pending') return true;
  return false;
}

export function useTaskPolling({
  taskId,
  enabled = true,
  intervalMs = 3000,
  t,
  restartKey = 0,
}: UseTaskPollingOptions): UseTaskPollingResult {
  const [data, setData] = useState<TaskStatusResponse | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const router = useRouter();

  // Stabilize `t` with a ref so callback/effect deps don't change on every render
  const tRef = useRef(t);
  tRef.current = t;

  // Stabilize `router` similarly — it's used inside fetchStatus.
  const routerRef = useRef(router);
  routerRef.current = router;

  const fetchStatus = useCallback(
    async (
      errorCount: number,
      signal: AbortSignal,
    ): Promise<{ shouldContinue: boolean; newErrorCount: number }> => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { signal });
        if (res.status === 401) {
          // Session expired during polling. Show a brief notice AND redirect
          // to /login so the user isn't stranded watching stale data.
          setError(tRef.current('session_expired'));
          routerRef.current.push('/login');
          return { shouldContinue: false, newErrorCount: 0 };
        }
        if (res.status === 404) {
          // Task is gone (deleted). Not a transport error — surface via the
          // dedicated `notFound` flag so consumers can render a calm tombstone
          // instead of the red poll-error treatment.
          setNotFound(true);
          setError(null);
          return { shouldContinue: false, newErrorCount: 0 };
        }
        if (!res.ok) {
          // Transient server error (5xx etc.) — retry with backoff
          const newCount = errorCount + 1;
          if (newCount >= MAX_CONSECUTIVE_ERRORS) {
            setError(tRef.current('server_error'));
            return { shouldContinue: false, newErrorCount: newCount };
          }
          setError(tRef.current('server_error_retrying'));
          return { shouldContinue: true, newErrorCount: newCount };
        }
        const json: TaskStatusResponse = await res.json();
        setData((prev) => (prev && deepEqualPollResponse(prev, json) ? prev : json));
        setError(null);

        const shouldContinue = json.status === 'pending' || json.status === 'processing';
        return { shouldContinue, newErrorCount: 0 };
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return { shouldContinue: false, newErrorCount: errorCount };
        }
        const newCount = errorCount + 1;
        if (newCount >= MAX_CONSECUTIVE_ERRORS) {
          setError(tRef.current('server_unreachable'));
          return { shouldContinue: false, newErrorCount: newCount };
        }
        setError(tRef.current('network_retrying'));
        return { shouldContinue: true, newErrorCount: newCount };
      }
    },
    [taskId],
  );

  useEffect(() => {
    if (!enabled) return;

    // restartKey is an invalidation sentinel — bumping it from outside should
    // re-run this effect even though we never read its value here. The void
    // statement makes the dependency real to the linter without changing behavior.
    void restartKey;

    // On restart, drop stale data + error so the UI immediately reflects the
    // re-polling intent (e.g. shows the pipeline strip while waiting for the
    // first poll after a retry, instead of lingering on the failed body).
    setData(null);
    setError(null);
    setNotFound(false);

    let active = true;
    const controller = new AbortController();
    setIsPolling(true);

    const poll = async () => {
      let errorCount = 0;
      const pollStart = Date.now();
      while (active) {
        if (Date.now() - pollStart > MAX_POLL_DURATION_MS) {
          setError(tRef.current('poll_timeout'));
          break;
        }
        const result = await fetchStatus(errorCount, controller.signal);
        errorCount = result.newErrorCount;
        if (!result.shouldContinue || !active) break;
        // Exponential backoff on consecutive errors
        const delay = errorCount > 0 ? intervalMs * 2 ** (errorCount - 1) : intervalMs;
        await new Promise((r) => setTimeout(r, delay));
      }
      if (active) setIsPolling(false);
    };

    poll();

    return () => {
      active = false;
      controller.abort();
      setIsPolling(false);
    };
  }, [enabled, fetchStatus, intervalMs, restartKey]);

  return { data, isPolling, error, notFound };
}
