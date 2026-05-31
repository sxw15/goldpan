import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sqliteVecAvailable = await (async () => {
  try {
    const { load } = await vi.importActual<typeof import('sqlite-vec')>('sqlite-vec');
    const db = new Database(':memory:');
    try {
      load(db);
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
})();

vi.mock('sqlite-vec', () => ({
  load: () => {
    /* no-op fallback */
  },
}));

import { createDatabase, getRawDatabase } from '../../src/db/connection.js';
import { ensureFtsTables } from '../../src/db/fts.js';
import { runMigrations } from '../../src/db/migrate.js';
import { notes } from '../../src/db/schema.js';
import { NOW_MS_SQL } from '../../src/db/sql-fragments.js';
import { ensureVecTables } from '../../src/db/vec.js';
import type { QueryUnderstanding } from '../../src/query/schema.js';
import { searchKnowledge } from '../../src/query/search.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

describe('searchKnowledge', () => {
  let testDB: TestDB;

  beforeEach(() => {
    testDB = createTestDB();
    seedTestData(testDB);
  });

  afterEach(() => {
    testDB.cleanup();
  });

  function makeParams(overrides: Partial<QueryUnderstanding> = {}): QueryUnderstanding {
    return {
      keywords: [],
      hasTimeHint: false,
      categoryHints: [],
      pointType: 'any',
      sourceKind: 'any',
      complexity: 'simple',
      ...overrides,
    };
  }

  it('returns empty results when no strategies match', async () => {
    const result = await searchKnowledge(makeParams({ keywords: ['nonexistent_xyz'] }), testDB.db);
    expect(result.entities).toEqual([]);
  });

  it('finds entities via FTS5 keyword search', async () => {
    const result = await searchKnowledge(makeParams({ keywords: ['React'] }), testDB.db);
    expect(result.entities.length).toBeGreaterThan(0);
    const react = result.entities.find((e) => e.name === 'React');
    expect(react).toBeDefined();
    expect(react!.matchedBy).toContain('fts');
    expect(react!.points.length).toBeGreaterThan(0);
  });

  it('finds entities via time-based recency', async () => {
    const result = await searchKnowledge(makeParams({ hasTimeHint: true }), testDB.db);
    expect(result.entities.length).toBeGreaterThan(0);
    const matched = result.entities.find((e) => e.matchedBy.includes('time'));
    expect(matched).toBeDefined();
  });

  it('finds entities via category search', async () => {
    const result = await searchKnowledge(makeParams({ categoryHints: ['Frontend'] }), testDB.db);
    expect(result.entities.length).toBeGreaterThan(0);
    const matched = result.entities.find((e) => e.matchedBy.includes('category'));
    expect(matched).toBeDefined();
  });

  it('finds entities via JSON keyword search', async () => {
    const result = await searchKnowledge(makeParams({ keywords: ['frontend'] }), testDB.db);
    expect(result.entities.length).toBeGreaterThan(0);
    const matched = result.entities.find((e) => e.matchedBy.includes('keyword_json'));
    expect(matched).toBeDefined();
  });

  it('merges results from multiple strategies (union)', async () => {
    const result = await searchKnowledge(
      makeParams({ keywords: ['React'], hasTimeHint: true, categoryHints: ['Frontend'] }),
      testDB.db,
    );
    expect(result.entities.length).toBeGreaterThan(0);
    const react = result.entities.find((e) => e.name === 'React');
    expect(react).toBeDefined();
    expect(react!.matchedBy.length).toBeGreaterThanOrEqual(2);
  });

  it('filters points by type when pointType is fact', async () => {
    const result = await searchKnowledge(
      makeParams({ keywords: ['React'], pointType: 'fact' }),
      testDB.db,
    );
    const react = result.entities.find((e) => e.name === 'React');
    expect(react).toBeDefined();
    for (const point of react!.points) {
      expect(point.type).toBe('fact');
    }
  });

  it('filters by source kind when sourceKind is external', async () => {
    const result = await searchKnowledge(
      makeParams({ hasTimeHint: true, sourceKind: 'external' }),
      testDB.db,
    );
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities.find((e) => e.name === 'Vue')).toBeUndefined();
  });

  it('includes entity metadata (aliases, keywords, categoryPaths)', async () => {
    const result = await searchKnowledge(makeParams({ keywords: ['React'] }), testDB.db);
    const react = result.entities.find((e) => e.name === 'React');
    expect(react).toBeDefined();
    expect(react!.aliases).toEqual(['ReactJS']);
    expect(react!.keywords).toContain('frontend');
    expect(react!.categoryPaths.length).toBeGreaterThan(0);
  });

  it('includes lastSourceDate for entities', async () => {
    const result = await searchKnowledge(makeParams({ keywords: ['React'] }), testDB.db);
    const react = result.entities.find((e) => e.name === 'React');
    expect(react).toBeDefined();
    expect(react!.lastSourceDate).toBeTruthy();
  });

  it('handles FTS5 special characters in keywords safely', async () => {
    const specialKeywords = ['"React"', 'C++', 'node.js', 'key OR value', 'NOT a keyword'];
    const result = await searchKnowledge(makeParams({ keywords: specialKeywords }), testDB.db);
    expect(result.entities).toBeDefined();
    expect(Array.isArray(result.entities)).toBe(true);
  });

  it('excludes entities with no active points', async () => {
    const raw = getRawDatabase(testDB.db);
    raw.exec(`
      INSERT INTO entities (id, name, description, aliases, keywords)
        VALUES (99, 'EmptyEntity', 'No active points', '[]', '[]');
      INSERT INTO knowledge_points (id, content, type, status)
        VALUES (99, 'discarded point', 'fact', 'discarded');
      INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
        VALUES (1, 99, 99, 'new');
    `);
    const result = await searchKnowledge(makeParams({ keywords: ['EmptyEntity'] }), testDB.db);
    const empty = result.entities.find((e) => e.name === 'EmptyEntity');
    expect(empty).toBeUndefined();
  });

  it('respects maxEntities option to return more entities', async () => {
    const raw = getRawDatabase(testDB.db);
    // Seed 25 entities to exceed default MAX_ENTITIES (20)
    for (let i = 10; i < 35; i++) {
      raw.exec(`
        INSERT INTO entities (id, name, description, aliases, keywords)
          VALUES (${i}, 'Entity${i}', 'Test entity ${i}', '[]', '["test"]');
        INSERT INTO knowledge_points (id, content, type, status)
          VALUES (${i * 10}, 'Fact about entity ${i}', 'fact', 'active');
        INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
          VALUES (1, ${i}, ${i * 10}, 'new');
      `);
    }
    // Default: at most 20 entities
    const defaultResult = await searchKnowledge(makeParams({ keywords: ['test'] }), testDB.db);
    expect(defaultResult.entities.length).toBeLessThanOrEqual(20);

    // With maxEntities: 30
    const expandedResult = await searchKnowledge(
      makeParams({ keywords: ['test'] }),
      testDB.db,
      'en',
      { maxEntities: 30 },
    );
    expect(expandedResult.entities.length).toBeGreaterThan(defaultResult.entities.length);
  });

  it('emphasizeTime boosts time-matched entities in sort order', async () => {
    // Seed a 3rd entity that matches FTS keyword but has NO source (no time match)
    const raw = getRawDatabase(testDB.db);
    raw.exec(`
      INSERT INTO entities (id, name, description, aliases, keywords)
        VALUES (3, 'React Native', 'Mobile framework based on React', '[]', '["React", "mobile"]');
      INSERT INTO knowledge_points (id, content, type, status)
        VALUES (5, 'React Native enables cross-platform development', 'fact', 'active');
      INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
        VALUES (1, 3, 5, 'new');
    `);

    const withEmphasis = await searchKnowledge(
      makeParams({ keywords: ['React'], hasTimeHint: true }),
      testDB.db,
      'en',
      { emphasizeTime: true },
    );

    expect(withEmphasis.entities.length).toBeGreaterThan(0);

    // The first result should be time-matched due to emphasizeTime boost
    expect(withEmphasis.entities[0].matchedBy).toContain('time');
  });

  it.skipIf(!sqliteVecAvailable)(
    'includes vec-matched entities in results when embedding enabled',
    async () => {
      const raw = getRawDatabase(testDB.db);
      const { load } = await vi.importActual<typeof import('sqlite-vec')>('sqlite-vec');
      load(raw);
      ensureVecTables(raw, 'test-model', 4);

      const entityId = 2;
      raw
        .prepare('INSERT INTO entities_vec(rowid, embedding) VALUES (?, ?)')
        .run(BigInt(entityId), new Float32Array([0.1, 0.2, 0.3, 0.4]));

      const mockProvider = {
        embed: async () => [0.1, 0.2, 0.3, 0.4],
        embedMany: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
        dimensions: 4,
        modelId: 'test-model',
      };

      const result = await searchKnowledge(
        makeParams({ keywords: ['nonexistent_xyz'] }),
        testDB.db,
        'en',
        { embeddingProvider: mockProvider, rawQuery: 'test query' },
      );

      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.entities[0].matchedBy).toContain('vec');
    },
  );
});

describe('searchKnowledge (zh / trigram)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'goldpan-test-zh-'));
    const dbPath = join(tmpDir, 'test.db');
    db = createDatabase(dbPath);

    const migrationsFolder = join(import.meta.dirname, '../../drizzle');
    runMigrations(db, migrationsFolder);

    const raw = getRawDatabase(db);
    ensureFtsTables(raw, 'zh');

    // Seed Chinese entity data
    raw.exec(`
      INSERT INTO categories (id, name, path, parent_id)
        VALUES (1, '技术', '/技术', NULL);
      INSERT INTO entities (id, name, description, aliases, keywords)
        VALUES (1, '人工智能', 'AI 技术', '["AI"]', '["机器学习", "深度学习"]');
      INSERT INTO entity_categories (entity_id, category_id)
        VALUES (1, 1);
      INSERT INTO knowledge_points (id, content, type, status)
        VALUES (1, '深度学习是人工智能的核心分支', 'fact', 'active');
      INSERT INTO sources (id, kind, normalized_url, original_url, raw_content, status, created_at)
        VALUES (1, 'external', 'https://example.com/ai', 'https://example.com/ai', NULL, 'confirmed', ${NOW_MS_SQL});
      INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
        VALUES (1, 1, 1, 'new');
    `);
  });

  afterEach(() => {
    const raw = getRawDatabase(db);
    raw.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeParams(overrides: Partial<QueryUnderstanding> = {}): QueryUnderstanding {
    return {
      keywords: [],
      hasTimeHint: false,
      categoryHints: [],
      pointType: 'any',
      sourceKind: 'any',
      complexity: 'simple',
      ...overrides,
    };
  }

  it('uses LIKE fallback for short CJK keywords (< 3 chars)', async () => {
    const raw = getRawDatabase(db);
    raw.exec(`
      INSERT INTO entities (id, name, description, aliases, keywords)
        VALUES (2, '云', '云计算服务', '[]', '[]');
      INSERT INTO knowledge_points (id, content, type, status)
        VALUES (2, '云计算按需提供资源', 'fact', 'active');
      INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
        VALUES (1, 2, 2, 'new');
    `);

    const result = await searchKnowledge(makeParams({ keywords: ['云'] }), db, 'zh');
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities.find((e) => e.name === '云')).toBeDefined();
  });

  it('finds entities via trigram FTS for keywords >= 3 chars', async () => {
    const result = await searchKnowledge(makeParams({ keywords: ['人工智能'] }), db, 'zh');
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities[0].name).toBe('人工智能');
  });

  it('combines trigram FTS and LIKE fallback for mixed-length keywords', async () => {
    const result = await searchKnowledge(makeParams({ keywords: ['人工智能', 'AI'] }), db, 'zh');
    expect(result.entities.length).toBeGreaterThan(0);
  });
});

// ─── Seed data ─────────────────────────────────────────────

function seedTestData(testDB: TestDB): void {
  const raw = getRawDatabase(testDB.db);
  raw.exec(`
    -- Categories
    INSERT INTO categories (id, name, path, parent_id)
      VALUES (1, 'Tech', '/Tech', NULL);
    INSERT INTO categories (id, name, path, parent_id)
      VALUES (2, 'Frontend', '/Tech/Frontend', 1);

    -- Entities
    INSERT INTO entities (id, name, description, aliases, keywords)
      VALUES (1, 'React', 'A JavaScript library for building UIs', '["ReactJS"]', '["frontend", "UI", "JavaScript"]');
    INSERT INTO entities (id, name, description, aliases, keywords)
      VALUES (2, 'Vue', 'Progressive JavaScript framework', '["VueJS"]', '["frontend", "framework"]');

    -- Entity-Category links
    INSERT INTO entity_categories (entity_id, category_id)
      VALUES (1, 2);
    INSERT INTO entity_categories (entity_id, category_id)
      VALUES (2, 2);

    -- Knowledge points
    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (1, 'React uses a virtual DOM for efficient rendering', 'fact', 'active');
    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (2, 'React hooks simplify state management', 'fact', 'active');
    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (3, 'I think React is great for large apps', 'opinion', 'active');
    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (4, 'Vue has a gentle learning curve', 'fact', 'active');

    -- Sources
    INSERT INTO sources (id, kind, normalized_url, original_url, raw_content, status, created_at)
      VALUES (1, 'external', 'https://example.com/react', 'https://example.com/react', NULL, 'confirmed', ${NOW_MS_SQL});
    INSERT INTO sources (id, kind, normalized_url, original_url, raw_content, status, created_at)
      VALUES (2, 'user', NULL, NULL, 'Vue is easy to learn', 'confirmed', ${NOW_MS_SQL});

    -- Source-Entity-Point links
    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (1, 1, 1, 'new');
    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (1, 1, 2, 'new');
    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (1, 1, 3, 'new');
    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (2, 2, 4, 'new');
  `);
}

// ─── P2: sources_fts + notes_fts projection ──────────────────

describe('searchKnowledge — sources_fts + notes_fts integration (P2)', () => {
  let testDB: TestDB;

  beforeEach(() => {
    testDB = createTestDB();
  });

  afterEach(() => {
    testDB.cleanup();
  });

  function makeParams(overrides: Partial<QueryUnderstanding> = {}): QueryUnderstanding {
    return {
      keywords: [],
      hasTimeHint: false,
      categoryHints: [],
      pointType: 'any',
      sourceKind: 'any',
      complexity: 'simple',
      ...overrides,
    };
  }

  /**
   * Seed entity + active knowledge_point + a backing source linked via
   * source_entity_points. The link is required because hydration filters out
   * entities whose points have no source_entity_points row.
   *
   * The source's title / raw_content are intentionally bland so it won't
   * accidentally satisfy source_fts MATCH on the test's target keyword.
   */
  function seedHydratable(
    raw: ReturnType<typeof getRawDatabase>,
    {
      entityId,
      name,
      pointId,
      pointContent,
      sourceId,
    }: {
      entityId: number;
      name: string;
      pointId: number;
      pointContent: string;
      sourceId: number;
    },
  ): void {
    raw.exec(`
      INSERT INTO entities (id, name, description, aliases, keywords)
        VALUES (${entityId}, '${name}', NULL, '[]', '[]');
      INSERT INTO knowledge_points (id, content, type, status)
        VALUES (${pointId}, '${pointContent}', 'fact', 'active');
      INSERT INTO sources (id, kind, normalized_url, original_url, raw_content, status)
        VALUES (${sourceId}, 'user', NULL, NULL, 'placeholder body for hydration', 'confirmed');
      INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
        VALUES (${sourceId}, ${entityId}, ${pointId}, 'new');
    `);
  }

  it('keyword hit in source raw_content projects back to linked entity (source_fts)', async () => {
    const raw = getRawDatabase(testDB.db);
    // Entity + active knowledge point linked via a source whose raw_content
    // contains the search keyword (entity name itself does NOT contain it,
    // so the only path to surface entity 100 is sources_fts → entity).
    raw.exec(`
      INSERT INTO entities (id, name, description, aliases, keywords)
        VALUES (100, 'WombatInc', NULL, '[]', '[]');
      INSERT INTO knowledge_points (id, content, type, status)
        VALUES (1000, 'WombatInc was founded in 2020', 'fact', 'active');
      INSERT INTO sources (id, kind, normalized_url, original_url, raw_content, status)
        VALUES (200, 'external', 'https://example.com/wombat', 'https://example.com/wombat',
                'marsupialQuokkaA1 are amazing', 'confirmed');
      INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
        VALUES (200, 100, 1000, 'new');
    `);

    const result = await searchKnowledge(
      makeParams({ keywords: ['marsupialQuokkaA1'] }),
      testDB.db,
      'en',
    );
    const matched = result.entities.find((e) => e.id === 100);
    expect(matched).toBeDefined();
    expect(matched?.matchedBy).toContain('source_fts');
  });

  it('keyword hit in user note content projects back to linked entity (note_fts)', async () => {
    const raw = getRawDatabase(testDB.db);
    seedHydratable(raw, {
      entityId: 101,
      name: 'Alice',
      pointId: 1001,
      pointContent: 'Alice is a colleague',
      sourceId: 210,
    });
    // Note linked to Alice; content keyword `quokkaX1` is NOT in entity / source
    raw.exec(`
      INSERT INTO notes (id, content, archived)
        VALUES (300, 'meeting with Alice yesterday about quokkaX1', 0);
      INSERT INTO note_entities (note_id, entity_id)
        VALUES (300, 101);
    `);

    const result = await searchKnowledge(makeParams({ keywords: ['quokkaX1'] }), testDB.db, 'en');
    const matched = result.entities.find((e) => e.id === 101);
    expect(matched).toBeDefined();
    expect(matched?.matchedBy).toContain('note_fts');
  });

  it('archived note is not surfaced via note_fts (trigger drops archived rows)', async () => {
    const raw = getRawDatabase(testDB.db);
    seedHydratable(raw, {
      entityId: 102,
      name: 'Bob',
      pointId: 1002,
      pointContent: 'Bob is a contact',
      sourceId: 211,
    });
    // FTS-safe keyword (no '-' which FTS treats as boolean NOT)
    raw.exec(`
      INSERT INTO notes (id, content, archived)
        VALUES (301, 'uniqueKeywordAbcxyz mention', 0);
      INSERT INTO note_entities (note_id, entity_id)
        VALUES (301, 102);
    `);
    // Sanity: before archiving, note_fts should surface entity 102
    const before = await searchKnowledge(
      makeParams({ keywords: ['uniqueKeywordAbcxyz'] }),
      testDB.db,
      'en',
    );
    expect(before.entities.find((e) => e.id === 102)?.matchedBy).toContain('note_fts');

    // Archive — UPDATE trigger should drop the FTS row
    testDB.db.update(notes).set({ archived: true }).where(eq(notes.id, 301)).run();

    const after = await searchKnowledge(
      makeParams({ keywords: ['uniqueKeywordAbcxyz'] }),
      testDB.db,
      'en',
    );
    const matched = after.entities.find((e) => e.id === 102);
    // Archived → note_fts path must NOT contribute. (Other paths could still hit
    // if entity name/keywords matched — here the keyword is unique to the note.)
    expect(matched?.matchedBy ?? []).not.toContain('note_fts');
  });

  it('source with no linked entity contributes nothing and does not crash', async () => {
    const raw = getRawDatabase(testDB.db);
    raw.exec(`
      INSERT INTO sources (id, kind, normalized_url, original_url, raw_content, status)
        VALUES (201, 'external', 'https://example.com/orphan', 'https://example.com/orphan',
                'orphanKeywordA1 only here', 'confirmed');
    `);
    const result = await searchKnowledge(
      makeParams({ keywords: ['orphanKeywordA1'] }),
      testDB.db,
      'en',
    );
    expect(result.entities).toEqual([]);
  });

  it('note with no linked entity contributes nothing and does not crash', async () => {
    const raw = getRawDatabase(testDB.db);
    raw.exec(`
      INSERT INTO notes (id, content, archived)
        VALUES (302, 'lonesomeKeywordA1 no links', 0);
    `);
    const result = await searchKnowledge(
      makeParams({ keywords: ['lonesomeKeywordA1'] }),
      testDB.db,
      'en',
    );
    expect(result.entities).toEqual([]);
  });

  it('entity matched by both entity_fts and source_fts is fused (single result, both tags)', async () => {
    const raw = getRawDatabase(testDB.db);
    // Entity name itself contains the keyword (entity_fts hit)
    raw.exec(`
      INSERT INTO entities (id, name, description, aliases, keywords)
        VALUES (103, 'Echidna', 'Spiny anteater', '[]', '[]');
      INSERT INTO knowledge_points (id, content, type, status)
        VALUES (1003, 'Echidnas lay eggs', 'fact', 'active');
      INSERT INTO sources (id, kind, normalized_url, original_url, raw_content, status)
        VALUES (203, 'external', 'https://example.com/echidna', 'https://example.com/echidna',
                'echidna observation in the wild', 'confirmed');
      INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
        VALUES (203, 103, 1003, 'new');
    `);

    const result = await searchKnowledge(makeParams({ keywords: ['echidna'] }), testDB.db, 'en');
    const matches = result.entities.filter((e) => e.id === 103);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toContain('fts');
    expect(matches[0].matchedBy).toContain('source_fts');
  });

  it('zh 1-char keyword in source raw_content projects back via LIKE fallback', async () => {
    const raw = getRawDatabase(testDB.db);
    seedHydratable(raw, {
      entityId: 104,
      name: 'CloudCo',
      pointId: 1004,
      pointContent: 'CloudCo has a fact',
      sourceId: 214,
    });
    raw.prepare(`UPDATE sources SET raw_content = '云' WHERE id = 214`).run();

    const result = await searchKnowledge(makeParams({ keywords: ['云'] }), testDB.db, 'zh');
    const matched = result.entities.find((e) => e.id === 104);
    expect(matched).toBeDefined();
    expect(matched?.matchedBy).toContain('source_fts');
  });

  it('zh 1-char keyword in note content projects back via LIKE fallback', async () => {
    const raw = getRawDatabase(testDB.db);
    seedHydratable(raw, {
      entityId: 105,
      name: 'SeaCo',
      pointId: 1005,
      pointContent: 'SeaCo has a fact',
      sourceId: 215,
    });
    raw.exec(`
      INSERT INTO notes (id, content, archived)
        VALUES (305, '海', 0);
      INSERT INTO note_entities (note_id, entity_id)
        VALUES (305, 105);
    `);

    const result = await searchKnowledge(makeParams({ keywords: ['海'] }), testDB.db, 'zh');
    const matched = result.entities.find((e) => e.id === 105);
    expect(matched).toBeDefined();
    expect(matched?.matchedBy).toContain('note_fts');
  });
});
