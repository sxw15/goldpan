import { getRawDatabase } from '@goldpan/core/db';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB } from '../../../../packages/core/tests/helpers/test-db';
import { ensureTrackingTables } from '../../src/db';
import { executeInterest } from '../../src/executor';
import { TrackingCrudService } from '../../src/service';
import type { TrackingService } from '../../src/types';

describe('Tracking integration — full lifecycle', () => {
  let db: any;
  let rawDb: any;
  let cleanup: () => void;
  let service: TrackingService;
  let mockPluginRegistry: any;
  let mockSubmitInput: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const testDb = createTestDB();
    db = testDb.db;
    rawDb = getRawDatabase(db);
    cleanup = testDb.cleanup;
    ensureTrackingTables(db);

    mockPluginRegistry = {
      executeToolValidated: vi.fn(),
      executeToolWithFallback: vi.fn(),
      resolveToolProvider: vi.fn().mockReturnValue(undefined),
      listToolCandidates: vi.fn().mockReturnValue([]),
    };

    mockSubmitInput = vi.fn();

    const scheduler = {
      startScheduler: vi.fn(),
      drainScheduler: vi.fn().mockResolvedValue(undefined),
    };

    service = new TrackingCrudService({
      db,
      pluginRegistry: mockPluginRegistry,
      scheduler,
      getMinRuleIntervalMinutes: () => 1,
    });
  });

  afterEach(() => cleanup());

  it('creates an interest, executes search, submits URLs, dedup on re-execution', async () => {
    // 1. Create interest
    const interest = service.createInterest({
      name: 'Test AI News',
      searchQueries: ['artificial intelligence'],
    });
    expect(interest.id).toBeGreaterThan(0);
    expect(interest.enabled).toBe(true);
    expect(interest.status).toBe('idle');

    // 2. Mock search returning 3 URLs
    const searchResults = {
      results: [
        { url: 'https://example.com/article-1', title: 'AI Article 1' },
        { url: 'https://example.com/article-2', title: 'AI Article 2' },
        { url: 'https://example.com/article-3', title: 'AI Article 3' },
      ],
    };
    mockPluginRegistry.executeToolWithFallback.mockResolvedValue(searchResults);

    // 3. Mock submit - all accepted
    let sourceIdCounter = 100;
    mockSubmitInput.mockImplementation(async () => ({
      status: 'accepted' as const,
      taskId: 1,
      sourceId: sourceIdCounter++,
      warnings: [],
    }));

    // 4. Create execution record and run executor
    const execRes = rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, status) VALUES (?, ${NOW_MS_SQL}, 'running')`,
      )
      .run(interest.id);
    const executionId = Number(execRes.lastInsertRowid);

    const result = await executeInterest(
      { id: interest.id, searchQueries: ['artificial intelligence'], toolProvider: null },
      executionId,
      {
        db,
        pluginRegistry: mockPluginRegistry,
        submitInput: mockSubmitInput,
      },
    );

    expect(result.status).toBe('done');
    expect(result.itemsFound).toBe(3);
    expect(result.itemsSubmitted).toBe(3);

    // 5. Verify items in DB
    const items = rawDb
      .prepare('SELECT * FROM tracking_items WHERE execution_id = ?')
      .all(executionId);
    expect(items).toHaveLength(3);
    expect(items.every((i: any) => i.status === 'submitted')).toBe(true);

    // 6. Verify sources got tracking origin
    expect(mockSubmitInput).toHaveBeenCalledTimes(3);
    for (const call of mockSubmitInput.mock.calls) {
      expect(call[1]).toEqual({ origin: 'tracking' });
    }

    // 7. Second execution with same URLs → items marked 'duplicate'
    mockPluginRegistry.executeToolWithFallback.mockResolvedValue(searchResults);
    const execRes2 = rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, status) VALUES (?, ${NOW_MS_SQL}, 'running')`,
      )
      .run(interest.id);
    const executionId2 = Number(execRes2.lastInsertRowid);

    mockSubmitInput.mockClear();
    const result2 = await executeInterest(
      { id: interest.id, searchQueries: ['artificial intelligence'], toolProvider: null },
      executionId2,
      {
        db,
        pluginRegistry: mockPluginRegistry,
        submitInput: mockSubmitInput,
      },
    );

    expect(result2.itemsFound).toBe(3);
    expect(result2.itemsSubmitted).toBe(0);
    expect(mockSubmitInput).not.toHaveBeenCalled();

    // All items should be 'duplicate'
    const items2 = rawDb
      .prepare('SELECT * FROM tracking_items WHERE execution_id = ?')
      .all(executionId2);
    expect(items2.every((i: any) => i.status === 'duplicate')).toBe(true);
  });

  it('CRUD operations: create, read, update, list, enable/disable, delete', () => {
    // Create
    const interest1 = service.createInterest({ name: 'Interest 1', searchQueries: ['test1'] });
    const interest2 = service.createInterest({ name: 'Interest 2', searchQueries: ['test2'] });

    // List
    const interests = service.getInterests();
    expect(interests).toHaveLength(2);

    // Read
    const fetched = service.getInterest(interest1.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('Interest 1');

    // Update
    const updated = service.updateInterest(interest1.id, {
      name: 'Updated Interest 1',
      searchQueries: ['updated'],
    });
    expect(updated.name).toBe('Updated Interest 1');

    // Disable
    const disabled = service.disableInterest(interest1.id);
    expect(disabled.enabled).toBe(false);

    // Enable
    const enabled = service.enableInterest(interest1.id);
    expect(enabled.enabled).toBe(true);

    // Delete
    service.deleteInterest(interest2.id);
    expect(service.getInterests()).toHaveLength(1);
  });

  it('execution history and detail retrieval', async () => {
    const interest = service.createInterest({ name: 'History Test', searchQueries: ['history'] });

    // Insert execution records manually
    rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, finished_at, status, items_found, items_submitted)
         VALUES (?, (${NOW_MS_SQL} - 3600000), ${NOW_MS_SQL}, 'done', 5, 3)`,
      )
      .run(interest.id);
    rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, finished_at, status, items_found, items_submitted)
         VALUES (?, ${NOW_MS_SQL}, ${NOW_MS_SQL}, 'done', 3, 1)`,
      )
      .run(interest.id);

    // Get interest executions with pagination
    const page1 = service.getInterestExecutions(interest.id, { page: 1, perPage: 1 });
    expect(page1.total).toBe(2);
    expect(page1.executions).toHaveLength(1);

    const page2 = service.getInterestExecutions(interest.id, { page: 2, perPage: 1 });
    expect(page2.executions).toHaveLength(1);
  });
});

describe('Tracking integration — error handling', () => {
  let db: any;
  let cleanup: () => void;
  let mockPluginRegistry: any;

  beforeEach(() => {
    const testDb = createTestDB();
    db = testDb.db;
    cleanup = testDb.cleanup;
    ensureTrackingTables(db);

    mockPluginRegistry = {
      executeToolValidated: vi.fn(),
      executeToolWithFallback: vi.fn(),
      resolveToolProvider: vi.fn().mockReturnValue(undefined),
      listToolCandidates: vi.fn().mockReturnValue([]),
    };
  });

  afterEach(() => cleanup());

  it('search tool failure results in error status', async () => {
    const rawDb = getRawDatabase(db);

    // Create interest + execution
    rawDb
      .prepare(
        `INSERT INTO tracking_rules (name, search_queries_json, status) VALUES ('Fail Test', '["fail"]', 'idle')`,
      )
      .run();
    const execRes = rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, status) VALUES (1, ${NOW_MS_SQL}, 'running')`,
      )
      .run();
    const executionId = Number(execRes.lastInsertRowid);

    mockPluginRegistry.executeToolWithFallback.mockRejectedValue(new Error('Search API down'));

    const result = await executeInterest(
      { id: 1, searchQueries: ['fail'], toolProvider: null },
      executionId,
      {
        db,
        pluginRegistry: mockPluginRegistry,
        submitInput: vi.fn(),
      },
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('Search API down');
    expect(result.itemsFound).toBe(0);
    expect(result.itemsSubmitted).toBe(0);
  });

  it('specific provider failure when tool_provider is set', async () => {
    const rawDb = getRawDatabase(db);

    rawDb
      .prepare(
        `INSERT INTO tracking_rules (name, search_queries_json, tool_provider, status) VALUES ('Provider Test', '["test"]', 'tavily', 'idle')`,
      )
      .run();
    const execRes = rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, status) VALUES (1, ${NOW_MS_SQL}, 'running')`,
      )
      .run();
    const executionId = Number(execRes.lastInsertRowid);

    mockPluginRegistry.executeToolValidated.mockRejectedValue(new Error('Tavily unavailable'));

    const result = await executeInterest(
      { id: 1, searchQueries: ['test'], toolProvider: 'tavily' },
      executionId,
      {
        db,
        pluginRegistry: mockPluginRegistry,
        submitInput: vi.fn(),
      },
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('Tavily unavailable');
  });
});
