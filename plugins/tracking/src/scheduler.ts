import type { DrizzleDB } from '@goldpan/core/db';
import { getRawDatabase } from '@goldpan/core/db';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import { errorMessage } from '@goldpan/core/errors';
import type { PluginRegistry } from '@goldpan/core/plugins';
import type { SubmitResult } from '@goldpan/core/submit';
import { executeInterest } from './executor.js';

/**
 * Per-tick mutable settings. Resolved by `SchedulerDeps.getRuntimeConfig` on
 * every tick / decision so a `configStore.commit({...})` to
 * `GOLDPAN_TRACKING_POLL_INTERVAL` / `_DAILY_SEARCH_LIMIT` /
 * `_MAX_RESULTS_PER_SEARCH` is observed by the next tick without a restart.
 *
 * Closure-capturing these values at scheduler construction (the previous
 * shape) re-introduces the bug — keep this struct ephemeral.
 */
export interface SchedulerRuntimeConfig {
  pollIntervalMs: number;
  dailySearchLimit: number;
  maxResultsPerSearch: number;
}

export interface SchedulerDeps {
  db: DrizzleDB;
  pluginRegistry: PluginRegistry;
  submitInput: (input: string, options?: { origin?: 'user' | 'tracking' }) => Promise<SubmitResult>;
  /**
   * Reads the latest runtime-config values. Called on every reschedule
   * (`scheduleTick`), every claimed-row decision (`dailySearchLimit` check),
   * and every `executeInterest` (`maxResultsPerSearch`). Must be cheap —
   * production wires a thin `process.env` parse, tests pass a stub.
   */
  getRuntimeConfig: () => SchedulerRuntimeConfig;
}

export interface SchedulerHandle {
  startScheduler: () => void;
  drainScheduler: () => Promise<void>;
}

declare global {
  var __goldpan_tracking_scheduler_started: boolean | undefined;
}

interface RawClaimedRow {
  id: number;
  name: string;
  search_queries_json: string;
  tool_provider: string | null;
  interval_minutes: number;
}

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

const DRAIN_TIMEOUT_MS = 30_000;

export function createScheduler(deps: SchedulerDeps): SchedulerHandle {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflightPromise: Promise<void> | null = null;
  let dailySearchCount = 0;
  let lastResetDate = '';
  let abortController: AbortController | null = null;

  const rawDb = getRawDatabase(deps.db);

  const claimStmt = rawDb.prepare(
    `UPDATE tracking_rules SET status='executing'
     WHERE id IN (
       SELECT id FROM tracking_rules
       WHERE enabled=1 AND status='idle' AND next_run_at <= ${NOW_MS_SQL}
       ORDER BY next_run_at ASC LIMIT 5
     ) RETURNING id, name, search_queries_json, tool_provider, interval_minutes`,
  );

  const resetRuleStmt = rawDb.prepare(`UPDATE tracking_rules SET status='idle' WHERE id = ?`);

  const skipRuleStmt = rawDb.prepare(
    `UPDATE tracking_rules
     SET status='idle', next_run_at = ${NOW_MS_SQL} + ? * 60000,
         updated_at = ${NOW_MS_SQL}
     WHERE id = ?`,
  );

  const insertExecStmt = rawDb.prepare(
    `INSERT INTO tracking_executions (rule_id, started_at, status)
     VALUES (?, ${NOW_MS_SQL}, 'running')`,
  );

  const finishExecStmt = rawDb.prepare(
    `UPDATE tracking_executions
     SET finished_at = ${NOW_MS_SQL}, status = ?, items_found = ?, items_submitted = ?, error_message = ?
     WHERE id = ?`,
  );

  const advanceRuleStmt = rawDb.prepare(
    `UPDATE tracking_rules
     SET status='idle', last_run_at = ${NOW_MS_SQL},
         next_run_at = ${NOW_MS_SQL} + ? * 60000,
         updated_at = ${NOW_MS_SQL}
     WHERE id = ?`,
  );

  const insertLogStmt = rawDb.prepare(
    `INSERT INTO tracking_logs (rule_id, execution_id, level, message)
     VALUES (?, ?, ?, ?)`,
  );

  function log(
    interestId: number | null,
    executionId: number | null,
    level: 'info' | 'warn' | 'error',
    message: string,
  ): void {
    try {
      insertLogStmt.run(interestId, executionId, level, message);
    } catch {
      // Logging failure must not crash the scheduler
    }
  }

  function scheduleTick(): void {
    if (!running) return;
    // Re-read pollIntervalMs every reschedule — a `configStore.commit({
    // GOLDPAN_TRACKING_POLL_INTERVAL: ... })` between ticks must affect the
    // *next* delay, not be frozen at scheduler construction.
    const { pollIntervalMs } = deps.getRuntimeConfig();
    timer = setTimeout(() => {
      inflightPromise = tick().finally(() => {
        inflightPromise = null;
        scheduleTick();
      });
    }, pollIntervalMs);
  }

  async function tick(): Promise<void> {
    if (!running) return;

    // Snapshot runtime config once per tick — `dailySearchLimit` and
    // `maxResultsPerSearch` come from the same struct so the whole batch
    // sees consistent values, while still picking up `commit()` changes on
    // the *next* tick.
    const runtime = deps.getRuntimeConfig();

    // Reset daily counter at midnight UTC
    const today = utcDateString();
    if (today !== lastResetDate) {
      dailySearchCount = 0;
      lastResetDate = today;
    }

    abortController = new AbortController();
    const { signal } = abortController;

    // Claim batch in transaction
    const claimed = rawDb
      .transaction(() => {
        return claimStmt.all() as RawClaimedRow[];
      })
      .immediate();

    if (claimed.length === 0) return;

    // Serial execution within the batch
    for (let i = 0; i < claimed.length; i++) {
      if (!running || signal.aborted) {
        for (let j = i; j < claimed.length; j++) {
          resetRuleStmt.run(claimed[j].id);
        }
        break;
      }

      const row = claimed[i];

      // Check daily limit BEFORE execution — advance next_run_at so rules
      // don't re-trigger on the next poll cycle (prevents busy-loop).
      if (dailySearchCount >= runtime.dailySearchLimit) {
        for (let j = i; j < claimed.length; j++) {
          skipRuleStmt.run(claimed[j].interval_minutes, claimed[j].id);
          log(claimed[j].id, null, 'warn', 'Daily search limit reached, skipping execution');
        }
        break;
      }

      // Create execution row
      const execRes = insertExecStmt.run(row.id);
      const executionId = Number(execRes.lastInsertRowid);

      log(row.id, executionId, 'info', `Starting execution for interest "${row.name}"`);

      try {
        // 列级 CHECK 已保结构：json_valid AND json_type='array'
        const searchQueries = JSON.parse(row.search_queries_json) as string[];
        const interestInput = {
          id: row.id,
          searchQueries,
          toolProvider: row.tool_provider,
        };

        const result = await executeInterest(
          interestInput,
          executionId,
          {
            db: deps.db,
            pluginRegistry: deps.pluginRegistry,
            submitInput: deps.submitInput,
            maxResultsPerSearch: runtime.maxResultsPerSearch,
          },
          signal,
        );

        finishExecStmt.run(
          result.status,
          result.itemsFound,
          result.itemsSubmitted,
          result.errorMessage ?? null,
          executionId,
        );

        log(
          row.id,
          executionId,
          result.status === 'error' ? 'error' : 'info',
          result.status === 'error'
            ? `Execution failed: ${result.errorMessage}`
            : `Execution done: ${result.itemsFound} found, ${result.itemsSubmitted} submitted`,
        );
      } catch (err) {
        const message = errorMessage(err);
        finishExecStmt.run('error', 0, 0, message, executionId);
        log(row.id, executionId, 'error', `Execution threw: ${message}`);
      }

      // Reset interest: status='idle', advance next_run_at from NOW
      advanceRuleStmt.run(row.interval_minutes, row.id);
      dailySearchCount++;
    }
  }

  function startScheduler(): void {
    if (globalThis.__goldpan_tracking_scheduler_started) return;
    globalThis.__goldpan_tracking_scheduler_started = true;
    running = true;
    scheduleTick();
  }

  async function drainScheduler(): Promise<void> {
    running = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (inflightPromise) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS));
      await Promise.race([inflightPromise, timeout]);
    }
    delete globalThis.__goldpan_tracking_scheduler_started;
  }

  return { startScheduler, drainScheduler };
}
