import { getRawDatabase } from '@goldpan/core/db';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB } from '../../../packages/core/tests/helpers/test-db';
import {
  INTEREST_EXECUTION_DETAIL_KEYS,
  INTEREST_EXECUTION_KEYS,
  INTEREST_ITEM_KEYS,
  INTEREST_KEYS,
} from '../../../packages/web-sdk/tests/fixtures/interest.fixture';
import { ensureTrackingTables } from '../src/db';
import { TrackingCrudService } from '../src/service';
import { TrackingServiceError } from '../src/types';

describe('TrackingCrudService', () => {
  let db: any;
  let cleanup: () => void;
  let service: TrackingCrudService;
  const mockPluginRegistry = {
    resolveToolProvider: vi.fn(),
  };
  const mockScheduler = {
    startScheduler: vi.fn(),
    drainScheduler: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    const testDb = createTestDB();
    db = testDb.db;
    cleanup = testDb.cleanup;
    ensureTrackingTables(db);
    mockPluginRegistry.resolveToolProvider.mockReset();
    mockScheduler.startScheduler.mockReset();
    mockScheduler.drainScheduler.mockReset().mockResolvedValue(undefined);
    service = new TrackingCrudService({
      db,
      pluginRegistry: mockPluginRegistry as any,
      scheduler: mockScheduler,
      getMinRuleIntervalMinutes: () => 5,
    });
  });
  afterEach(() => cleanup());

  // ─── createInterest ──────────────────────────────────────

  it('createInterest with valid input', () => {
    const interest = service.createInterest({ name: 'My Interest', searchQueries: ['ai', 'llm'] });
    expect(interest.id).toBeGreaterThan(0);
    expect(interest.name).toBe('My Interest');
    expect(interest.searchQueries).toEqual(['ai', 'llm']);
    expect(interest.description).toBeNull();
    expect(interest.toolProvider).toBeNull();
    expect(interest.intervalMinutes).toBe(60);
    expect(interest.enabled).toBe(true);
    expect(interest.status).toBe('idle');
    expect(interest.linkedEntityIds).toEqual([]);
    expect(interest.nextRunAt).toBeTruthy();
    expect(interest.createdAt).toBeTruthy();
    // Three-side shape contract: plugin mapInterestRow must produce every key
    // the SDK Interest declares (and nothing else). Drift here fails early.
    expect(Object.keys(interest).sort()).toEqual(INTEREST_KEYS);
  });

  it('createInterest with description and custom interval', () => {
    const interest = service.createInterest({
      name: 'Custom',
      searchQueries: ['test site:example.com'],
      intervalMinutes: 120,
      description: 'keep me',
    });
    expect(interest.intervalMinutes).toBe(120);
    expect(interest.description).toBe('keep me');
    expect(interest.searchQueries).toEqual(['test site:example.com']);
  });

  it('createInterest enforces minRuleIntervalMinutes', () => {
    const interest = service.createInterest({
      name: 'Fast',
      searchQueries: ['test'],
      intervalMinutes: 1,
    });
    expect(interest.intervalMinutes).toBe(5); // min is 5
  });

  it('createInterest with empty searchQueries throws validation_error', () => {
    expect(() => service.createInterest({ name: 'Bad', searchQueries: [] })).toThrow(
      TrackingServiceError,
    );
    try {
      service.createInterest({ name: 'Bad', searchQueries: [] });
    } catch (e: any) {
      expect(e.code).toBe('validation_error');
    }
  });

  it('createInterest with empty string searchQuery throws validation_error', () => {
    expect(() => service.createInterest({ name: 'Bad', searchQueries: [''] })).toThrow(
      TrackingServiceError,
    );
    try {
      service.createInterest({ name: 'Bad', searchQueries: [''] });
    } catch (e: any) {
      expect(e.code).toBe('validation_error');
    }
  });

  it('createInterest with empty name throws validation_error', () => {
    expect(() => service.createInterest({ name: '', searchQueries: ['test'] })).toThrow(
      TrackingServiceError,
    );
    try {
      service.createInterest({ name: '', searchQueries: ['test'] });
    } catch (e: any) {
      expect(e.code).toBe('validation_error');
    }
  });

  it('createInterest with whitespace-only name throws validation_error', () => {
    expect(() => service.createInterest({ name: '   ', searchQueries: ['test'] })).toThrow(
      TrackingServiceError,
    );
    try {
      service.createInterest({ name: '   ', searchQueries: ['test'] });
    } catch (e: any) {
      expect(e.code).toBe('validation_error');
    }
  });

  it('createInterest with name over 200 chars throws validation_error', () => {
    expect(() =>
      service.createInterest({ name: 'a'.repeat(201), searchQueries: ['test'] }),
    ).toThrow(TrackingServiceError);
    try {
      service.createInterest({ name: 'a'.repeat(201), searchQueries: ['test'] });
    } catch (e: any) {
      expect(e.code).toBe('validation_error');
    }
  });

  it('createInterest trims name', () => {
    const interest = service.createInterest({ name: '  test interest  ', searchQueries: ['test'] });
    expect(interest.name).toBe('test interest');
  });

  it('createInterest with invalid toolProvider throws invalid_provider', () => {
    mockPluginRegistry.resolveToolProvider.mockReturnValue(undefined);
    expect(() =>
      service.createInterest({
        name: 'Bad',
        searchQueries: ['test'],
        toolProvider: 'nonexistent',
      }),
    ).toThrow(TrackingServiceError);
    try {
      service.createInterest({
        name: 'Bad',
        searchQueries: ['test'],
        toolProvider: 'nonexistent',
      });
    } catch (e: any) {
      expect(e.code).toBe('invalid_provider');
    }
  });

  it('createInterest with valid toolProvider succeeds', () => {
    mockPluginRegistry.resolveToolProvider.mockReturnValue({ plugin: {}, declaration: {} });
    const interest = service.createInterest({
      name: 'With Provider',
      searchQueries: ['test'],
      toolProvider: 'tavily',
    });
    expect(interest.toolProvider).toBe('tavily');
    expect(mockPluginRegistry.resolveToolProvider).toHaveBeenCalledWith('tavily', 'search');
  });

  // ─── getInterest / getInterests ──────────────────────────

  it('getInterest returns interest by id', () => {
    const created = service.createInterest({ name: 'Find me', searchQueries: ['x'] });
    const found = service.getInterest(created.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('Find me');
  });

  it('getInterest returns undefined for nonexistent id', () => {
    expect(service.getInterest(999)).toBeUndefined();
  });

  it('getInterests returns all interests', () => {
    service.createInterest({ name: 'Interest 1', searchQueries: ['a'] });
    service.createInterest({ name: 'Interest 2', searchQueries: ['b'] });
    const interests = service.getInterests();
    expect(interests).toHaveLength(2);
    expect(interests[0].name).toBe('Interest 1');
    expect(interests[1].name).toBe('Interest 2');
  });

  // ─── updateInterest ──────────────────────────────────────

  it('updateInterest updates name and searchQueries', () => {
    const created = service.createInterest({ name: 'Original', searchQueries: ['old'] });
    const updated = service.updateInterest(created.id, {
      name: 'Updated',
      searchQueries: ['new'],
    });
    expect(updated.name).toBe('Updated');
    expect(updated.searchQueries).toEqual(['new']);
  });

  it('updateInterest preserves unchanged fields', () => {
    const created = service.createInterest({
      name: 'Original',
      searchQueries: ['old'],
      description: 'keep me',
    });
    const updated = service.updateInterest(created.id, { name: 'New Name' });
    expect(updated.name).toBe('New Name');
    expect(updated.searchQueries).toEqual(['old']);
    expect(updated.description).toBe('keep me');
  });

  it('updateInterest nonexistent throws not_found', () => {
    expect(() => service.updateInterest(999, { name: 'x' })).toThrow(TrackingServiceError);
    try {
      service.updateInterest(999, { name: 'x' });
    } catch (e: any) {
      expect(e.code).toBe('not_found');
    }
  });

  it('updateInterest with invalid toolProvider throws invalid_provider', () => {
    const created = service.createInterest({ name: 'Test', searchQueries: ['test'] });
    mockPluginRegistry.resolveToolProvider.mockReturnValue(undefined);
    expect(() => service.updateInterest(created.id, { toolProvider: 'bad' })).toThrow(
      TrackingServiceError,
    );
    try {
      service.updateInterest(created.id, { toolProvider: 'bad' });
    } catch (e: any) {
      expect(e.code).toBe('invalid_provider');
    }
  });

  it('updateInterest with empty name throws validation_error', () => {
    const created = service.createInterest({ name: 'Test', searchQueries: ['test'] });
    expect(() => service.updateInterest(created.id, { name: '' })).toThrow(TrackingServiceError);
    try {
      service.updateInterest(created.id, { name: '' });
    } catch (e: any) {
      expect(e.code).toBe('validation_error');
    }
  });

  it('updateInterest with name over 200 chars throws validation_error', () => {
    const created = service.createInterest({ name: 'Test', searchQueries: ['test'] });
    expect(() => service.updateInterest(created.id, { name: 'a'.repeat(201) })).toThrow(
      TrackingServiceError,
    );
    try {
      service.updateInterest(created.id, { name: 'a'.repeat(201) });
    } catch (e: any) {
      expect(e.code).toBe('validation_error');
    }
  });

  // ─── deleteInterest ──────────────────────────────────────

  it('deleteInterest removes the interest', () => {
    const created = service.createInterest({ name: 'Delete me', searchQueries: ['x'] });
    service.deleteInterest(created.id);
    expect(service.getInterest(created.id)).toBeUndefined();
  });

  it('deleteInterest on nonexistent throws not_found', () => {
    expect(() => service.deleteInterest(999)).toThrow(TrackingServiceError);
    try {
      service.deleteInterest(999);
    } catch (e: any) {
      expect(e.code).toBe('not_found');
    }
  });

  it('deleteInterest on executing interest throws conflict', () => {
    const created = service.createInterest({ name: 'Busy', searchQueries: ['x'] });
    const rawDb = getRawDatabase(db);
    rawDb.prepare(`UPDATE tracking_rules SET status = 'executing' WHERE id = ?`).run(created.id);
    expect(() => service.deleteInterest(created.id)).toThrow(TrackingServiceError);
    try {
      service.deleteInterest(created.id);
    } catch (e: any) {
      expect(e.code).toBe('conflict');
    }
  });

  it('deleteInterest cleans up sources.tracking_rule_id', () => {
    const created = service.createInterest({ name: 'Tracked', searchQueries: ['x'] });
    const rawDb = getRawDatabase(db);
    rawDb
      .prepare(
        `INSERT INTO sources (kind, original_url, normalized_url, status, origin, tracking_rule_id, created_at, updated_at)
         VALUES ('external', 'https://example.com', 'example.com', 'processing', 'tracking', ?, ${NOW_MS_SQL}, ${NOW_MS_SQL})`,
      )
      .run(created.id);
    service.deleteInterest(created.id);
    const source = rawDb
      .prepare(`SELECT tracking_rule_id FROM sources WHERE original_url = 'https://example.com'`)
      .get() as any;
    expect(source.tracking_rule_id).toBeNull();
  });

  // ─── enableInterest / disableInterest ────────────────────

  it('enableInterest enables a disabled interest', () => {
    const created = service.createInterest({ name: 'Toggle', searchQueries: ['x'] });
    service.disableInterest(created.id);
    const interest = service.enableInterest(created.id);
    expect(interest.enabled).toBe(true);
  });

  it('disableInterest disables an interest', () => {
    const created = service.createInterest({ name: 'Toggle', searchQueries: ['x'] });
    const interest = service.disableInterest(created.id);
    expect(interest.enabled).toBe(false);
  });

  it('enableInterest on nonexistent throws not_found', () => {
    expect(() => service.enableInterest(999)).toThrow(TrackingServiceError);
    try {
      service.enableInterest(999);
    } catch (e: any) {
      expect(e.code).toBe('not_found');
    }
  });

  it('disableInterest on nonexistent throws not_found', () => {
    expect(() => service.disableInterest(999)).toThrow(TrackingServiceError);
    try {
      service.disableInterest(999);
    } catch (e: any) {
      expect(e.code).toBe('not_found');
    }
  });

  // ─── triggerExecution ────────────────────────────────────

  it('triggerExecution sets next_run_at to "now"', () => {
    const created = service.createInterest({ name: 'Trigger', searchQueries: ['x'] });
    const rawDb = getRawDatabase(db);
    const yearMs = 365 * 86_400_000;
    rawDb
      .prepare(`UPDATE tracking_rules SET next_run_at = ${NOW_MS_SQL} + ${yearMs} WHERE id = ?`)
      .run(created.id);
    const before = Date.now();
    service.triggerExecution(created.id);
    const after = Date.now();
    const interest = service.getInterest(created.id)!;
    // nextRunAt should land within the window we straddle around the trigger.
    expect(interest.nextRunAt).not.toBeNull();
    expect(interest.nextRunAt as number).toBeGreaterThanOrEqual(before - 2_000);
    expect(interest.nextRunAt as number).toBeLessThanOrEqual(after + 2_000);
  });

  it('triggerExecution on nonexistent throws not_found', () => {
    expect(() => service.triggerExecution(999)).toThrow(TrackingServiceError);
    try {
      service.triggerExecution(999);
    } catch (e: any) {
      expect(e.code).toBe('not_found');
    }
  });

  it('triggerExecution on executing interest throws conflict', () => {
    const created = service.createInterest({ name: 'Busy', searchQueries: ['x'] });
    const rawDb = getRawDatabase(db);
    rawDb.prepare(`UPDATE tracking_rules SET status = 'executing' WHERE id = ?`).run(created.id);
    expect(() => service.triggerExecution(created.id)).toThrow(TrackingServiceError);
    try {
      service.triggerExecution(created.id);
    } catch (e: any) {
      expect(e.code).toBe('conflict');
    }
  });

  // ─── getInterestListStats ────────────────────────────────

  it('getInterestListStats aggregates per-rule hits + 14-day sparkline', () => {
    const a = service.createInterest({ name: 'A', searchQueries: ['a'] });
    const b = service.createInterest({ name: 'B', searchQueries: ['b'] });
    const rawDb = getRawDatabase(db);

    // A: 2 historical (10/12 days ago, no contribution to 24h) + 1 recent
    // B: only 1 ancient run (no 24h hits)
    rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, status, items_found, items_submitted)
         VALUES (?, (${NOW_MS_SQL} - 864000000), 'done', ?, ?)`,
      )
      .run(a.id, 3, 1);
    rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, status, items_found, items_submitted)
         VALUES (?, (${NOW_MS_SQL} - 1036800000), 'done', ?, ?)`,
      )
      .run(a.id, 2, 0);
    // Anchor to "today UTC midnight" so the `newHits24h` assertion (which
    // counts executions from the start of the current UTC day onward)
    // doesn't flake when the test runs before 02:00 UTC on the wall clock.
    rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, status, items_found, items_submitted)
         VALUES (?, CAST(ROUND((julianday(date('now')) - 2440587.5) * 86400000) AS INTEGER), 'done', ?, ?)`,
      )
      .run(a.id, 5, 4);
    rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, status, items_found, items_submitted)
         VALUES (?, (${NOW_MS_SQL} - 2592000000), 'done', ?, ?)`,
      )
      .run(b.id, 7, 7);

    const stats = service.getInterestListStats();

    const aStats = stats.get(a.id);
    expect(aStats).toBeDefined();
    expect(aStats!.totalHits).toBe(10);
    expect(aStats!.newHits24h).toBe(5);
    expect(aStats!.ingestedTotal).toBe(5);
    expect(aStats!.sparkline).toHaveLength(14);
    // Last bucket (today) has the start-of-day execution.
    expect(aStats!.sparkline.at(-1)).toBe(5);

    const bStats = stats.get(b.id);
    expect(bStats).toBeDefined();
    expect(bStats!.totalHits).toBe(7);
    expect(bStats!.newHits24h).toBe(0);
    // 30-day-old run falls outside the 14-day window, all zero buckets.
    expect(bStats!.sparkline).toEqual(new Array(14).fill(0));
  });

  // ─── getExecution ────────────────────────────────────────

  it('getExecution returns execution with items', () => {
    const interest = service.createInterest({ name: 'Exec', searchQueries: ['x'] });
    const rawDb = getRawDatabase(db);
    const execResult = rawDb
      .prepare(
        `INSERT INTO tracking_executions (rule_id, started_at, status, items_found, items_submitted)
         VALUES (?, ${NOW_MS_SQL}, 'done', 2, 1)`,
      )
      .run(interest.id);
    const execId = Number(execResult.lastInsertRowid);
    rawDb
      .prepare(
        `INSERT INTO tracking_items (rule_id, execution_id, url, status) VALUES (?, ?, ?, ?)`,
      )
      .run(interest.id, execId, 'https://a.com', 'submitted');
    rawDb
      .prepare(
        `INSERT INTO tracking_items (rule_id, execution_id, url, status) VALUES (?, ?, ?, ?)`,
      )
      .run(interest.id, execId, 'https://b.com', 'duplicate');

    const execution = service.getExecution(execId);
    expect(execution).toBeDefined();
    expect(execution!.status).toBe('done');
    expect(execution!.items).toHaveLength(2);
    expect(execution!.items[0].url).toBe('https://a.com');
    expect(execution!.items[1].url).toBe('https://b.com');
    // Shape contract. Plugin-layer items carry the extra `sourceId` column
    // that the server route strips before serializing to SDK clients.
    expect(Object.keys(execution!).sort()).toEqual(INTEREST_EXECUTION_DETAIL_KEYS);
    expect(Object.keys(execution!.items[0]).sort()).toEqual(
      [...INTEREST_ITEM_KEYS, 'sourceId'].sort(),
    );
  });

  it('getExecution returns undefined for nonexistent', () => {
    expect(service.getExecution(999)).toBeUndefined();
  });

  // ─── getInterestExecutions ───────────────────────────────

  it('getInterestExecutions returns paginated results', () => {
    const interest = service.createInterest({ name: 'Paginate', searchQueries: ['x'] });
    const rawDb = getRawDatabase(db);
    for (let i = 0; i < 5; i++) {
      rawDb
        .prepare(
          `INSERT INTO tracking_executions (rule_id, started_at, status)
           VALUES (?, datetime('now', '+${i} minutes'), 'done')`,
        )
        .run(interest.id);
    }

    const page1 = service.getInterestExecutions(interest.id, { page: 1, perPage: 2 });
    expect(page1.total).toBe(5);
    expect(page1.executions).toHaveLength(2);
    // Shape contract. List items lack `items` (that only comes from the
    // detail endpoint) so they match INTEREST_EXECUTION_KEYS exactly.
    expect(Object.keys(page1.executions[0]).sort()).toEqual(INTEREST_EXECUTION_KEYS);

    const page2 = service.getInterestExecutions(interest.id, { page: 2, perPage: 2 });
    expect(page2.executions).toHaveLength(2);

    const page3 = service.getInterestExecutions(interest.id, { page: 3, perPage: 2 });
    expect(page3.executions).toHaveLength(1);
  });

  it('getInterestExecutions defaults to page 1, perPage 30', () => {
    const interest = service.createInterest({ name: 'Default', searchQueries: ['x'] });
    const result = service.getInterestExecutions(interest.id);
    expect(result.total).toBe(0);
    expect(result.executions).toEqual([]);
  });

  it('getInterestExecutions on nonexistent interest throws not_found', () => {
    expect(() => service.getInterestExecutions(999)).toThrow(TrackingServiceError);
    try {
      service.getInterestExecutions(999);
    } catch (e: any) {
      expect(e.code).toBe('not_found');
    }
  });

  it('getInterestExecutions clamps perPage to max 100', () => {
    const interest = service.createInterest({ name: 'Clamp', searchQueries: ['x'] });
    const result = service.getInterestExecutions(interest.id, { perPage: 200 });
    expect(result.total).toBe(0);
  });

  // ─── scheduler delegation ───────────────────────────────

  it('startScheduler delegates to scheduler', () => {
    service.startScheduler();
    expect(mockScheduler.startScheduler).toHaveBeenCalledTimes(1);
  });

  it('drainScheduler delegates to scheduler', async () => {
    await service.drainScheduler();
    expect(mockScheduler.drainScheduler).toHaveBeenCalledTimes(1);
  });

  // ─── linkedEntityIds junction (interest_entity_links) ─────

  describe('linked entities junction', () => {
    it('createInterest writes interest_entity_links rows and getInterest returns linkedEntityIds', () => {
      const rawDb = getRawDatabase(db);
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(10, 'E10');
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(20, 'E20');

      const created = service.createInterest({
        name: 'Test',
        searchQueries: ['foo'],
        linkedEntityIds: [10, 20],
      });

      expect(created.linkedEntityIds).toEqual([10, 20]);

      const fetched = service.getInterest(created.id);
      expect(fetched?.linkedEntityIds).toEqual([10, 20]);

      const links = rawDb
        .prepare(
          `SELECT interest_id, entity_id FROM interest_entity_links WHERE interest_id = ? ORDER BY entity_id`,
        )
        .all(created.id);
      expect(links).toEqual([
        { interest_id: created.id, entity_id: 10 },
        { interest_id: created.id, entity_id: 20 },
      ]);
    });

    it('createInterest without linkedEntityIds returns empty array', () => {
      const created = service.createInterest({ name: 'Solo', searchQueries: ['x'] });
      expect(created.linkedEntityIds).toEqual([]);
      const fetched = service.getInterest(created.id);
      expect(fetched?.linkedEntityIds).toEqual([]);
    });

    it('getInterests populates linkedEntityIds on each returned Interest', () => {
      const rawDb = getRawDatabase(db);
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(30, 'E30');
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(40, 'E40');

      service.createInterest({ name: 'A', searchQueries: ['a'], linkedEntityIds: [30] });
      service.createInterest({ name: 'B', searchQueries: ['b'], linkedEntityIds: [30, 40] });
      service.createInterest({ name: 'C', searchQueries: ['c'] });

      const interests = service.getInterests();
      expect(interests).toHaveLength(3);
      expect(interests[0].linkedEntityIds).toEqual([30]);
      expect(interests[1].linkedEntityIds).toEqual([30, 40]);
      expect(interests[2].linkedEntityIds).toEqual([]);
    });

    it('updateInterest replaces links (full-replace semantics) when linkedEntityIds provided', () => {
      const rawDb = getRawDatabase(db);
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(50, 'E50');
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(60, 'E60');
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(70, 'E70');

      const created = service.createInterest({
        name: 'Original',
        searchQueries: ['x'],
        linkedEntityIds: [50, 60],
      });

      const updated = service.updateInterest(created.id, { linkedEntityIds: [70] });
      expect(updated.linkedEntityIds).toEqual([70]);

      const links = rawDb
        .prepare(
          `SELECT entity_id FROM interest_entity_links WHERE interest_id = ? ORDER BY entity_id`,
        )
        .all(created.id) as Array<{ entity_id: number }>;
      expect(links.map((l) => l.entity_id)).toEqual([70]);
    });

    it('createInterest with duplicate linkedEntityIds dedupes before insert', () => {
      const rawDb = getRawDatabase(db);
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(10, 'E10');

      const created = service.createInterest({
        name: 'Dup',
        searchQueries: ['foo'],
        linkedEntityIds: [10, 10, 10],
      });
      expect(created.linkedEntityIds).toEqual([10]);
    });

    it('createInterest with unknown linkedEntityIds throws validation_error listing missing ids', () => {
      const rawDb = getRawDatabase(db);
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(1, 'E1');

      try {
        service.createInterest({
          name: 'Missing',
          searchQueries: ['foo'],
          linkedEntityIds: [1, 999],
        });
        throw new Error('expected createInterest to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TrackingServiceError);
        expect((err as TrackingServiceError).code).toBe('validation_error');
        expect((err as Error).message).toMatch(/unknown entities.*999/);
      }
    });

    it('updateInterest with unknown linkedEntityIds preserves existing links (pre-delete validation)', () => {
      const rawDb = getRawDatabase(db);
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(50, 'E50');

      const created = service.createInterest({
        name: 'Keep',
        searchQueries: ['x'],
        linkedEntityIds: [50],
      });

      try {
        service.updateInterest(created.id, { linkedEntityIds: [50, 9999] });
        throw new Error('expected updateInterest to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TrackingServiceError);
        expect((err as TrackingServiceError).code).toBe('validation_error');
      }

      // Existing link set survives the failed update.
      const remaining = rawDb
        .prepare(
          `SELECT entity_id FROM interest_entity_links WHERE interest_id = ? ORDER BY entity_id`,
        )
        .all(created.id) as Array<{ entity_id: number }>;
      expect(remaining.map((r) => r.entity_id)).toEqual([50]);
    });

    it('deleteInterest clears interest_entity_links via FK CASCADE and sets sources.tracking_rule_id NULL', () => {
      const rawDb = getRawDatabase(db);
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(10, 'E10');
      const created = service.createInterest({
        name: 'Test',
        searchQueries: ['foo'],
        linkedEntityIds: [10],
      });

      rawDb
        .prepare(
          `INSERT INTO sources (id, normalized_url, original_url, kind, status, origin, tracking_rule_id, created_at, updated_at) VALUES (?, ?, ?, 'external', 'processing', 'tracking', ?, ${NOW_MS_SQL}, ${NOW_MS_SQL})`,
        )
        .run(999, 'https://a.test/x', 'https://a.test/x', created.id);

      service.deleteInterest(created.id);

      const remainingLinks = rawDb
        .prepare(`SELECT COUNT(*) as c FROM interest_entity_links WHERE interest_id = ?`)
        .get(created.id) as { c: number };
      expect(remainingLinks.c).toBe(0);

      const sourceRow = rawDb
        .prepare(`SELECT tracking_rule_id FROM sources WHERE id = 999`)
        .get() as { tracking_rule_id: number | null };
      expect(sourceRow.tracking_rule_id).toBeNull();
    });
  });

  describe('createInterest enabled default', () => {
    it('defaults enabled=true when not specified (chat intent flow)', () => {
      const i = service.createInterest({ name: 'A', searchQueries: ['a'] });
      expect(i.enabled).toBe(true);
    });

    it('honors explicit enabled=false (UI EntityPayload CTA flow)', () => {
      const i = service.createInterest({ name: 'B', searchQueries: ['b'], enabled: false });
      expect(i.enabled).toBe(false);
    });

    it('createInterestWithResolution resolved path delegates to normal validations', () => {
      expect(() =>
        service.createInterestWithResolution({
          name: 'resolved',
          searchQueries: ['x'.repeat(101)],
          enabled: true,
          resolutionStatus: 'resolved',
        }),
      ).toThrow(/searchQuery/);

      const created = service.createInterestWithResolution({
        name: 'resolved',
        searchQueries: ['x'],
        intervalMinutes: 1,
        enabled: true,
        resolutionStatus: 'resolved',
      });
      expect(service.getInterest(created.id)?.intervalMinutes).toBe(5);
    });

    it('enableInterest rejects unresolved pending rows with a controlled conflict', () => {
      const pending = service.createInterestWithResolution({
        name: 'pending',
        searchQueries: [],
        enabled: false,
        resolutionStatus: 'pending_pipeline',
        pendingResolution: { sourceId: 1 },
      });

      expect(() => service.enableInterest(pending.id)).toThrow(TrackingServiceError);
      expect(() => service.enableInterest(pending.id)).toThrow(/pending resolution/);
    });
  });

  // ─── P4 deferred resolver helpers ────────────────────────

  describe('P4 deferred resolver helpers', () => {
    it('findPendingByPipelineSource(sourceId) returns all pending_pipeline rows for that source', () => {
      const r1 = service.createInterestWithResolution({
        name: 'A',
        searchQueries: [],
        linkedSourceId: 42,
        enabled: false,
        resolutionStatus: 'pending_pipeline',
        pendingResolution: { sourceId: 42, conversationId: 1 },
      });
      const r2 = service.createInterestWithResolution({
        name: 'B',
        searchQueries: [],
        linkedSourceId: 42,
        enabled: false,
        resolutionStatus: 'pending_pipeline',
        pendingResolution: { sourceId: 42, conversationId: 2 },
      });
      const r3 = service.createInterestWithResolution({
        name: 'C',
        searchQueries: [],
        linkedSourceId: 42,
        enabled: false,
        resolutionStatus: 'awaiting_clarify',
        pendingResolution: {
          sourceId: 42,
          candidateEntityIds: [1, 2],
          conversationId: 3,
        },
      });
      const r4 = service.createInterestWithResolution({
        name: 'D',
        searchQueries: [],
        linkedSourceId: 99,
        enabled: false,
        resolutionStatus: 'pending_pipeline',
        pendingResolution: { sourceId: 99, conversationId: 4 },
      });

      const found = service.findPendingByPipelineSource(42);
      const ids = found.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
      expect(ids).not.toContain(r3.id);
      expect(ids).not.toContain(r4.id);
      const payloadById = new Map(found.map((r) => [r.id, r.pendingResolution]));
      expect(payloadById.get(r1.id)?.conversationId).toBe(1);
      expect(payloadById.get(r2.id)?.conversationId).toBe(2);
    });

    it('markResolved CAS — pending_pipeline -> resolved + enabled=1 + name + searchQueries + entity link', () => {
      const rawDb = getRawDatabase(db);
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(101, 'Anthropic');
      const r = service.createInterestWithResolution({
        name: 'placeholder',
        searchQueries: [],
        linkedSourceId: 7,
        enabled: false,
        resolutionStatus: 'pending_pipeline',
        pendingResolution: { sourceId: 7, conversationId: 1, placeholderName: 'placeholder' },
      });
      const ok = service.markResolved(r.id, {
        name: 'Anthropic',
        searchQueries: ['Anthropic'],
        linkedEntityIds: [101],
        expectedStatus: 'pending_pipeline',
      });
      expect(ok).toBe(true);
      const row = service.getInterest(r.id);
      expect(row?.name).toBe('Anthropic');
      expect(row?.enabled).toBe(true);
      const statusRow = rawDb
        .prepare('SELECT resolution_status FROM tracking_rules WHERE id = ?')
        .get(r.id) as { resolution_status: string } | undefined;
      expect(statusRow?.resolution_status).toBe('resolved');
      const link = rawDb
        .prepare('SELECT entity_id FROM interest_entity_links WHERE interest_id = ?')
        .get(r.id) as { entity_id: number } | undefined;
      expect(link?.entity_id).toBe(101);
    });

    it('markResolved CAS failure (status drifted) returns false and writes nothing', () => {
      const rawDb = getRawDatabase(db);
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(201, 'X');
      rawDb.prepare(`INSERT INTO entities (id, name) VALUES (?, ?)`).run(202, 'Y');
      const r = service.createInterestWithResolution({
        name: 'p',
        searchQueries: [],
        linkedSourceId: 7,
        enabled: false,
        resolutionStatus: 'pending_pipeline',
        pendingResolution: { sourceId: 7, conversationId: 1 },
      });
      service.markResolved(r.id, {
        name: 'X',
        searchQueries: ['X'],
        linkedEntityIds: [201],
        expectedStatus: 'pending_pipeline',
      });
      const second = service.markResolved(r.id, {
        name: 'Y',
        searchQueries: ['Y'],
        linkedEntityIds: [202],
        expectedStatus: 'pending_pipeline',
      });
      expect(second).toBe(false);
      const row = service.getInterest(r.id);
      expect(row?.name).toBe('X');
    });

    it('markFailedResolution flips to failed_no_entity and keeps enabled=0', () => {
      const r = service.createInterestWithResolution({
        name: 'p',
        searchQueries: [],
        linkedSourceId: 7,
        enabled: false,
        resolutionStatus: 'pending_pipeline',
        pendingResolution: { sourceId: 7, conversationId: 1 },
      });
      const ok = service.markFailedResolution(r.id, {
        targetStatus: 'failed_no_entity',
        expectedStatus: 'pending_pipeline',
      });
      expect(ok).toBe(true);
      const rawDb = getRawDatabase(db);
      const statusRow = rawDb
        .prepare('SELECT resolution_status, enabled FROM tracking_rules WHERE id = ?')
        .get(r.id) as { resolution_status: string; enabled: number };
      expect(statusRow.resolution_status).toBe('failed_no_entity');
      expect(statusRow.enabled).toBe(0);
    });

    it('markAwaitingClarify upgrades pending_pipeline -> awaiting_clarify, merges candidateEntityIds, preserves conversationId', () => {
      const r = service.createInterestWithResolution({
        name: 'p',
        searchQueries: [],
        linkedSourceId: 7,
        enabled: false,
        resolutionStatus: 'pending_pipeline',
        pendingResolution: {
          sourceId: 7,
          conversationId: 1,
          placeholderName: 'p',
          sessionRef: { channelId: 'tg', accountId: 'a', chatId: 'c', userId: 'u' },
        },
      });
      const ok = service.markAwaitingClarify(r.id, {
        candidateEntityIds: [1, 2, 3],
        expectedStatus: 'pending_pipeline',
      });
      expect(ok).toBe(true);
      const rawDb = getRawDatabase(db);
      const statusRow = rawDb
        .prepare('SELECT resolution_status FROM tracking_rules WHERE id = ?')
        .get(r.id) as { resolution_status: string };
      expect(statusRow.resolution_status).toBe('awaiting_clarify');
      const payloadRow = rawDb
        .prepare('SELECT pending_resolution FROM tracking_rules WHERE id = ?')
        .get(r.id) as { pending_resolution: string };
      const payload = JSON.parse(payloadRow.pending_resolution);
      expect(payload.candidateEntityIds).toEqual([1, 2, 3]);
      expect(payload.conversationId).toBe(1);
      expect(payload.placeholderName).toBe('p');
      expect(payload.sessionRef.channelId).toBe('tg');
    });

    it('findAwaitingClarifyOlderThan(cutoffMs) returns awaiting_clarify rows updated before cutoff', () => {
      const r1 = service.createInterestWithResolution({
        name: 'old',
        searchQueries: [],
        linkedSourceId: 1,
        enabled: false,
        resolutionStatus: 'awaiting_clarify',
        pendingResolution: { sourceId: 1, candidateEntityIds: [1], conversationId: 1 },
      });
      const rawDb = getRawDatabase(db);
      rawDb
        .prepare('UPDATE tracking_rules SET updated_at = ? WHERE id = ?')
        .run(Date.now() - 25 * 3600 * 1000, r1.id);
      service.createInterestWithResolution({
        name: 'fresh',
        searchQueries: [],
        linkedSourceId: 2,
        enabled: false,
        resolutionStatus: 'awaiting_clarify',
        pendingResolution: { sourceId: 2, candidateEntityIds: [2], conversationId: 2 },
      });

      const found = service.findAwaitingClarifyOlderThan(Date.now() - 24 * 3600 * 1000);
      expect(found.map((r) => r.id)).toEqual([r1.id]);
      expect(found[0].pendingResolution?.conversationId).toBe(1);
    });
  });
});
