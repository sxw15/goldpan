import { getRawDatabase } from '@goldpan/core/db';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB } from '../../../packages/core/tests/helpers/test-db';
import { ensureTrackingTables } from '../src/db';
import { type ExecutorDeps, executeInterest } from '../src/executor';

function insertInterest(
  rawDb: ReturnType<typeof getRawDatabase>,
  overrides: Record<string, unknown> = {},
): number {
  const searchQueriesJson = overrides.search_queries_json ?? JSON.stringify(['test']);
  const toolProvider = overrides.tool_provider ?? null;
  const res = rawDb
    .prepare(
      `INSERT INTO tracking_rules (name, search_queries_json, tool_provider, interval_minutes, next_run_at)
       VALUES ('Test Interest', ?, ?, 60, ${NOW_MS_SQL})`,
    )
    .run(searchQueriesJson, toolProvider);
  return Number(res.lastInsertRowid);
}

function insertExecution(rawDb: ReturnType<typeof getRawDatabase>, interestId: number): number {
  const res = rawDb
    .prepare(
      `INSERT INTO tracking_executions (rule_id, started_at, status)
       VALUES (?, ${NOW_MS_SQL}, 'running')`,
    )
    .run(interestId);
  return Number(res.lastInsertRowid);
}

function getItems(rawDb: ReturnType<typeof getRawDatabase>, executionId: number) {
  return rawDb
    .prepare('SELECT * FROM tracking_items WHERE execution_id = ? ORDER BY id')
    .all(executionId) as Array<{
    id: number;
    rule_id: number;
    execution_id: number;
    url: string;
    title: string | null;
    published_at: number | null;
    status: string;
    source_id: number | null;
  }>;
}

describe('executeInterest', () => {
  let db: any;
  let rawDb: any;
  let cleanup: () => void;

  const mockPluginRegistry = {
    executeToolValidated: vi.fn(),
    executeToolWithFallback: vi.fn(),
  };

  const mockSubmitInput = vi.fn();

  let deps: ExecutorDeps;

  beforeEach(() => {
    const testDb = createTestDB();
    db = testDb.db;
    rawDb = getRawDatabase(db);
    cleanup = testDb.cleanup;
    ensureTrackingTables(db);

    mockPluginRegistry.executeToolValidated.mockReset();
    mockPluginRegistry.executeToolWithFallback.mockReset();
    mockSubmitInput.mockReset();

    deps = {
      db,
      pluginRegistry: mockPluginRegistry as any,
      submitInput: mockSubmitInput,
    };
  });

  afterEach(() => cleanup());

  it('executes search → dedup → submit new URLs', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [
        { url: 'https://example.com/a', title: 'Page A', snippet: 'Snippet A' },
        { url: 'https://example.com/b', title: 'Page B', snippet: 'Snippet B' },
      ],
      searchEngine: 'mock',
    });

    mockSubmitInput.mockResolvedValue({
      status: 'accepted',
      taskId: 1,
      sourceId: 100,
    });

    const result = await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    expect(result.status).toBe('done');
    expect(result.itemsFound).toBe(2);
    expect(result.itemsSubmitted).toBe(2);
    expect(mockSubmitInput).toHaveBeenCalledTimes(2);

    const items = getItems(rawDb, execId);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === 'submitted')).toBe(true);
  });

  it('stores search result publishedAt as epoch milliseconds on the normal URL path', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);
    const publishedAt = '2026-04-10T00:00:00.000Z';

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [
        {
          url: 'https://example.com/published',
          title: 'Published',
          snippet: 'S',
          publishedAt,
        },
      ],
      searchEngine: 'mock',
    });
    mockSubmitInput.mockResolvedValue({ status: 'duplicate', existingSourceId: 42 });

    await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    const [item] = getItems(rawDb, execId);
    expect(item.published_at).toBe(Date.parse(publishedAt));
    const typeRow = rawDb
      .prepare('SELECT typeof(published_at) AS t FROM tracking_items WHERE id = ?')
      .get(item.id) as { t: string };
    expect(typeRow.t).toBe('integer');
  });

  it('handles duplicate URLs within same execution (ON CONFLICT)', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [
        { url: 'https://example.com/same', title: 'Page 1', snippet: 'S1' },
        { url: 'https://example.com/same', title: 'Page 2', snippet: 'S2' },
      ],
      searchEngine: 'mock',
    });

    mockSubmitInput.mockResolvedValue({
      status: 'accepted',
      taskId: 1,
      sourceId: 100,
    });

    const result = await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    expect(result.itemsFound).toBe(1);
    const items = getItems(rawDb, execId);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('submitted');
  });

  it('cross-execution dedup (same interest, same URL, different execution → duplicate)', async () => {
    const interestId = insertInterest(rawDb);

    // First execution: submit a URL
    const execId1 = insertExecution(rawDb, interestId);
    rawDb
      .prepare(
        `INSERT INTO tracking_items (rule_id, execution_id, url, title, status)
         VALUES (?, ?, 'https://example.com/page', 'Old', 'submitted')`,
      )
      .run(interestId, execId1);

    // Second execution
    const execId2 = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [{ url: 'https://example.com/page', title: 'Page', snippet: 'S' }],
      searchEngine: 'mock',
    });

    const result = await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId2,
      deps,
    );

    expect(result.itemsFound).toBe(1);
    expect(result.itemsSubmitted).toBe(0);
    expect(mockSubmitInput).not.toHaveBeenCalled();

    const items = getItems(rawDb, execId2);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('duplicate');
  });

  it('dedup against existing sources table', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    // Insert an existing source with the same normalized URL
    rawDb
      .prepare(
        `INSERT INTO sources (kind, normalized_url, original_url, status, origin)
         VALUES ('external', 'https://example.com/exists', 'https://example.com/exists', 'confirmed', 'user')`,
      )
      .run();

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [{ url: 'https://example.com/exists', title: 'Existing', snippet: 'S' }],
      searchEngine: 'mock',
    });

    const result = await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    expect(result.itemsFound).toBe(1);
    expect(result.itemsSubmitted).toBe(0);
    expect(mockSubmitInput).not.toHaveBeenCalled();

    const items = getItems(rawDb, execId);
    expect(items[0].status).toBe('duplicate');
  });

  it('submitInput returning duplicate → marks item duplicate', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [{ url: 'https://example.com/dup', title: 'Dup', snippet: 'S' }],
      searchEngine: 'mock',
    });

    mockSubmitInput.mockResolvedValue({
      status: 'duplicate',
      existingSourceId: 42,
    });

    const result = await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    expect(result.itemsSubmitted).toBe(0);
    const items = getItems(rawDb, execId);
    expect(items[0].status).toBe('duplicate');
  });

  it('submitInput returning rejected → marks item failed', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [{ url: 'https://example.com/bad', title: 'Bad', snippet: 'S' }],
      searchEngine: 'mock',
    });

    mockSubmitInput.mockResolvedValue({
      status: 'rejected',
      code: 'url_blocked',
      reason: 'SSRF blocked',
    });

    const result = await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    expect(result.itemsSubmitted).toBe(0);
    const items = getItems(rawDb, execId);
    expect(items[0].status).toBe('failed');
  });

  it('submitInput throwing → marks item failed, continues with others', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [
        { url: 'https://example.com/err', title: 'Err', snippet: 'S' },
        { url: 'https://example.com/ok', title: 'OK', snippet: 'S' },
      ],
      searchEngine: 'mock',
    });

    mockSubmitInput
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValueOnce({ status: 'accepted', taskId: 2, sourceId: 200 });

    const result = await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    expect(result.itemsFound).toBe(2);
    expect(result.itemsSubmitted).toBe(1);
    expect(result.status).toBe('error');
    expect(result.errorMessage).toBe('One or more submissions failed');
  });

  it('sets sources.tracking_rule_id after successful submit', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [{ url: 'https://example.com/track', title: 'T', snippet: 'S' }],
      searchEngine: 'mock',
    });

    // Insert a source that submitInput will "accept"
    const sourceRes = rawDb
      .prepare(
        `INSERT INTO sources (kind, normalized_url, original_url, status, origin)
         VALUES ('external', 'https://example.com/new-source', 'https://example.com/new-source', 'processing', 'tracking')`,
      )
      .run();
    const sourceId = Number(sourceRes.lastInsertRowid);

    mockSubmitInput.mockResolvedValue({
      status: 'accepted',
      taskId: 1,
      sourceId,
    });

    await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    const src = rawDb
      .prepare('SELECT tracking_rule_id FROM sources WHERE id = ?')
      .get(sourceId) as { tracking_rule_id: number | null };
    expect(src.tracking_rule_id).toBe(interestId);
  });

  it('all search providers fail → execution status error', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockRejectedValue(
      new AggregateError([new Error('fail')], 'All providers failed'),
    );

    const result = await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('All providers failed');
    expect(result.itemsFound).toBe(0);
    expect(result.itemsSubmitted).toBe(0);
  });

  it('explicit tool_provider → uses executeToolValidated', async () => {
    const interestId = insertInterest(rawDb, { tool_provider: 'my-search-plugin' });
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolValidated.mockResolvedValue({
      results: [{ url: 'https://example.com/x', title: 'X', snippet: 'S' }],
      searchEngine: 'specific',
    });

    mockSubmitInput.mockResolvedValue({ status: 'accepted', taskId: 1, sourceId: 50 });

    await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: 'my-search-plugin' },
      execId,
      deps,
    );

    expect(mockPluginRegistry.executeToolValidated).toHaveBeenCalledWith(
      'my-search-plugin',
      'search',
      expect.objectContaining({ query: 'test' }),
      undefined,
    );
    expect(mockPluginRegistry.executeToolWithFallback).not.toHaveBeenCalled();
  });

  it('null tool_provider → uses executeToolWithFallback', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [],
      searchEngine: 'fallback',
    });

    await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    expect(mockPluginRegistry.executeToolWithFallback).toHaveBeenCalledWith(
      'search',
      expect.objectContaining({ query: 'test' }),
      undefined,
    );
    expect(mockPluginRegistry.executeToolValidated).not.toHaveBeenCalled();
  });

  it('multiple searchQueries are joined with OR', async () => {
    const interestId = insertInterest(rawDb, {
      search_queries_json: JSON.stringify(['alpha', 'beta', 'gamma']),
    });
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [],
      searchEngine: 'mock',
    });

    await executeInterest(
      {
        id: interestId,
        searchQueries: ['alpha', 'beta', 'gamma'],
        toolProvider: null,
      },
      execId,
      deps,
    );

    expect(mockPluginRegistry.executeToolWithFallback).toHaveBeenCalledWith(
      'search',
      expect.objectContaining({ query: 'alpha OR beta OR gamma' }),
      undefined,
    );
  });

  it('malformed URLs that fail normalizeUrl are marked failed, valid URLs still processed', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [
        { url: ':::not-a-valid-url', title: 'Bad', snippet: 'S' },
        { url: 'https://example.com/good', title: 'Good', snippet: 'S' },
      ],
      searchEngine: 'mock',
    });

    mockSubmitInput.mockResolvedValue({
      status: 'accepted',
      taskId: 1,
      sourceId: 100,
    });

    const result = await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
    );

    // Should not throw; valid URL still processed
    expect(result.status).toBe('done');
    expect(result.itemsSubmitted).toBe(1);
    expect(mockSubmitInput).toHaveBeenCalledTimes(1);

    const items = getItems(rawDb, execId);
    const badItem = items.find((i) => i.url === ':::not-a-valid-url');
    const goodItem = items.find((i) => i.url === 'https://example.com/good');
    expect(badItem).toBeDefined();
    expect(badItem!.status).toBe('failed');
    expect(goodItem).toBeDefined();
    expect(goodItem!.status).toBe('submitted');
  });

  it('stops processing results when signal is aborted', async () => {
    const interestId = insertInterest(rawDb);
    const execId = insertExecution(rawDb, interestId);

    mockPluginRegistry.executeToolWithFallback.mockResolvedValue({
      results: [
        { url: 'https://example.com/1', title: 'P1', snippet: 'S' },
        { url: 'https://example.com/2', title: 'P2', snippet: 'S' },
        { url: 'https://example.com/3', title: 'P3', snippet: 'S' },
      ],
      searchEngine: 'mock',
    });

    mockSubmitInput.mockResolvedValue({
      status: 'accepted',
      taskId: 1,
      sourceId: 100,
    });

    const controller = new AbortController();
    // Abort before calling executeInterest so the loop breaks on the first iteration
    controller.abort();

    const result = await executeInterest(
      { id: interestId, searchQueries: ['test'], toolProvider: null },
      execId,
      deps,
      controller.signal,
    );

    // No results processed because signal was already aborted
    expect(result.itemsFound).toBe(0);
    expect(result.itemsSubmitted).toBe(0);
    expect(mockSubmitInput).not.toHaveBeenCalled();
  });
});
