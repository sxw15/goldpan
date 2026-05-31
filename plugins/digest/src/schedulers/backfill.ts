import { errorMessage } from '@goldpan/core/errors';
import type { ILogObj, Logger } from 'tslog';
import type { DigestId, GenerateResult } from '../types.js';

export interface BackfillDeps {
  generate: (id: DigestId, opts: { includeAiSummary: true }) => Promise<GenerateResult>;
  getMissing: (date: string) => string[];
  date: string;
  /**
   * Persist the generated snapshot. Required: the previous shim swallowed
   * results and `daily_reports` was never populated by the backfill path
   * (P0-1). Implementations typically forward to `DigestCrudService.saveReport`.
   */
  saveReport: (channelId: string, result: GenerateResult) => void | Promise<void>;
  /** Optional logger for per-channel failure diagnostics (P1-6). */
  logger?: Logger<ILogObj>;
}

/**
 * On startup, generate the digest snapshot for `date` for every channel that
 * does not yet have a report on that date. Per-channel errors are logged and
 * isolated so one broken channel cannot starve the rest.
 */
export async function backfillMissing(deps: BackfillDeps): Promise<void> {
  for (const channel of deps.getMissing(deps.date)) {
    try {
      const result = await deps.generate(
        { channel, date: deps.date, presetId: null },
        { includeAiSummary: true },
      );
      await deps.saveReport(channel, result);
    } catch (err) {
      deps.logger?.warn('digest backfill failed for channel', {
        channelId: channel,
        date: deps.date,
        error: errorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
}
