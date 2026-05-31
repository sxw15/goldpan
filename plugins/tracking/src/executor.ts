import type { DrizzleDB } from '@goldpan/core/db';
import { getRawDatabase } from '@goldpan/core/db';
import { errorMessage } from '@goldpan/core/errors';
import type { PluginRegistry, SearchOutput } from '@goldpan/core/plugins';
import type { SubmitResult } from '@goldpan/core/submit';
import { normalizeUrl } from '@goldpan/core/utils';

export interface ExecutorDeps {
  db: DrizzleDB;
  pluginRegistry: PluginRegistry;
  submitInput: (input: string, options?: { origin?: 'user' | 'tracking' }) => Promise<SubmitResult>;
  maxResultsPerSearch?: number;
}

export interface ExecutionResult {
  itemsFound: number;
  itemsSubmitted: number;
  status: 'done' | 'error';
  errorMessage?: string;
}

export interface InterestInput {
  id: number;
  searchQueries: string[];
  toolProvider: string | null;
}

export function buildSearchQuery(interest: InterestInput): string {
  return interest.searchQueries.join(' OR ');
}

/** Parse ISO-8601 string from search tool into epoch ms; null if missing/invalid. */
function parsePublishedAt(s: string | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export async function executeInterest(
  interest: InterestInput,
  executionId: number,
  deps: ExecutorDeps,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  const rawDb = getRawDatabase(deps.db);
  const query = buildSearchQuery(interest);
  const maxResults = deps.maxResultsPerSearch ?? 10;

  let searchOutput: SearchOutput;
  try {
    const searchInput = { query, maxResults };
    if (interest.toolProvider) {
      searchOutput = (await deps.pluginRegistry.executeToolValidated(
        interest.toolProvider,
        'search',
        searchInput,
        signal,
      )) as SearchOutput;
    } else {
      searchOutput = (await deps.pluginRegistry.executeToolWithFallback(
        'search',
        searchInput,
        signal,
      )) as SearchOutput;
    }
  } catch (err) {
    return { itemsFound: 0, itemsSubmitted: 0, status: 'error', errorMessage: errorMessage(err) };
  }

  const results = searchOutput.results;
  let itemsFound = 0;
  let itemsSubmitted = 0;
  let hadError = false;

  const insertItem = rawDb.prepare(
    `INSERT INTO tracking_items (rule_id, execution_id, url, title, snippet, published_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'found')
     ON CONFLICT(execution_id, url) DO NOTHING`,
  );
  const updateItemStatus = rawDb.prepare(
    `UPDATE tracking_items SET status = ?, source_id = ? WHERE id = ?`,
  );
  const checkCrossExec = rawDb.prepare(
    `SELECT id FROM tracking_items WHERE rule_id = ? AND url = ? AND execution_id != ?
     AND status IN ('submitted', 'duplicate') LIMIT 1`,
  );
  const checkSource = rawDb.prepare(
    `SELECT id FROM sources WHERE normalized_url = ? AND status IN ('processing', 'confirmed') LIMIT 1`,
  );
  const setTrackingRuleId = rawDb.prepare(`UPDATE sources SET tracking_rule_id = ? WHERE id = ?`);

  for (const result of results) {
    if (signal?.aborted) break;

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeUrl(result.url);
    } catch {
      // URL normalization failure — insert with 'failed' status
      const res = insertItem.run(
        interest.id,
        executionId,
        result.url,
        result.title ?? null,
        result.snippet ?? null,
        parsePublishedAt(result.publishedAt),
      );
      if (res.changes > 0) {
        const itemId = Number(res.lastInsertRowid);
        updateItemStatus.run('failed', null, itemId);
        itemsFound++;
      }
      continue;
    }

    // Insert the item with 'found' status (ON CONFLICT DO NOTHING for same execution+url)
    const insertRes = insertItem.run(
      interest.id,
      executionId,
      normalizedUrl,
      result.title ?? null,
      result.snippet ?? null,
      parsePublishedAt(result.publishedAt),
    );

    // If ON CONFLICT triggered, skip this duplicate within the same execution
    if (insertRes.changes === 0) continue;

    itemsFound++;
    const itemId = Number(insertRes.lastInsertRowid);

    // Cross-execution dedup: same interest + same URL in a different execution
    const crossExecRow = checkCrossExec.get(interest.id, normalizedUrl, executionId);
    if (crossExecRow) {
      updateItemStatus.run('duplicate', null, itemId);
      continue;
    }

    // Dedup against existing sources table
    const sourceRow = checkSource.get(normalizedUrl) as { id: number } | undefined;
    if (sourceRow) {
      updateItemStatus.run('duplicate', null, itemId);
      continue;
    }

    // Submit with original URL so sources.originalUrl preserves the real address;
    // submitInput() normalizes internally for its own dedup.
    try {
      const submitResult = await deps.submitInput(result.url, { origin: 'tracking' });

      if (submitResult.status === 'accepted') {
        updateItemStatus.run('submitted', submitResult.sourceId, itemId);
        setTrackingRuleId.run(interest.id, submitResult.sourceId);
        itemsSubmitted++;
      } else if (submitResult.status === 'duplicate') {
        updateItemStatus.run('duplicate', null, itemId);
      } else {
        // rejected
        updateItemStatus.run('failed', null, itemId);
      }
    } catch {
      hadError = true;
      updateItemStatus.run('failed', null, itemId);
    }
  }

  return {
    itemsFound,
    itemsSubmitted,
    status: hadError ? 'error' : 'done',
    errorMessage: hadError ? 'One or more submissions failed' : undefined,
  };
}
