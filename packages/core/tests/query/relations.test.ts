import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection.js';
import { NOW_MS_SQL } from '../../src/db/sql-fragments.js';
import type { SearchResult } from '../../src/query/search.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

describe('expandWithRelations', () => {
  let testDB: TestDB;

  beforeEach(() => {
    testDB = createTestDB();
    seedEntitiesAndRelations(testDB);
  });

  afterEach(() => {
    testDB.cleanup();
  });

  it('returns empty string when no entities in search results', async () => {
    const { expandWithRelations } = await import('../../src/query/relations.js');
    const result = expandWithRelations({ entities: [] }, testDB.db);
    expect(result.relationsContext).toBe('');
    expect(result.searchResults.entities).toEqual([]);
  });

  it('returns empty string when entity_relations table does not exist', async () => {
    const { expandWithRelations } = await import('../../src/query/relations.js');
    const raw = getRawDatabase(testDB.db);
    raw.exec('DROP TABLE IF EXISTS entity_relations');
    const searchResults: SearchResult = {
      entities: [
        {
          id: 1,
          name: 'TestEntity',
          description: null,
          aliases: [],
          keywords: [],
          categoryPaths: [],
          lastSourceDate: null,
          points: [],
          matchedBy: ['fts'],
        },
      ],
    };
    const result = expandWithRelations(searchResults, testDB.db);
    expect(result.relationsContext).toBe('');
    expect(searchResults.entities).toHaveLength(1);
  });

  it('returns relations text for entities with relations', async () => {
    const { expandWithRelations } = await import('../../src/query/relations.js');
    const searchResults: SearchResult = {
      entities: [
        {
          id: 1,
          name: 'OpenAI',
          description: 'AI company',
          aliases: [],
          keywords: [],
          categoryPaths: [],
          lastSourceDate: null,
          points: [{ id: 10, content: 'Makes GPT', type: 'fact' }],
          matchedBy: ['fts'],
        },
      ],
    };
    const result = expandWithRelations(searchResults, testDB.db);
    expect(result.relationsContext).toContain(
      '- Microsoft → OpenAI: collaborative — Invested $10B in OpenAI',
    );
  });

  it('expands missing entities from relations into searchResults', async () => {
    const { expandWithRelations } = await import('../../src/query/relations.js');
    const searchResults: SearchResult = {
      entities: [
        {
          id: 1,
          name: 'OpenAI',
          description: 'AI company',
          aliases: [],
          keywords: [],
          categoryPaths: [],
          lastSourceDate: null,
          points: [{ id: 10, content: 'Makes GPT', type: 'fact' }],
          matchedBy: ['fts'],
        },
      ],
    };
    const { searchResults: expanded } = expandWithRelations(searchResults, testDB.db);
    expect(searchResults.entities).toHaveLength(1);
    const microsoft = expanded.entities.find((e) => e.name === 'Microsoft');
    expect(microsoft).toBeDefined();
    expect(microsoft!.matchedBy).toContain('relation');
    expect(microsoft!.points.length).toBeGreaterThan(0);
  });

  it('returns empty string when entities have no relations', async () => {
    const { expandWithRelations } = await import('../../src/query/relations.js');
    const searchResults: SearchResult = {
      entities: [
        {
          id: 99,
          name: 'Lonely',
          description: null,
          aliases: [],
          keywords: [],
          categoryPaths: [],
          lastSourceDate: null,
          points: [{ id: 990, content: 'No relations', type: 'fact' }],
          matchedBy: ['fts'],
        },
      ],
    };
    const result = expandWithRelations(searchResults, testDB.db);
    expect(result.relationsContext).toBe('');
  });
});

function seedEntitiesAndRelations(testDB: TestDB): void {
  const raw = getRawDatabase(testDB.db);

  // Check if entity_relations table exists (created by relations spec migration)
  const tableExists = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_relations'")
    .get();

  if (!tableExists) {
    raw.exec(`
      CREATE TABLE entity_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        target_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        description TEXT NOT NULL,
        source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL DEFAULT (${NOW_MS_SQL}),
        updated_at INTEGER NOT NULL DEFAULT (${NOW_MS_SQL}),
        UNIQUE(source_entity_id, target_entity_id, relation_type)
      );
    `);
  }

  raw.exec(`
    INSERT INTO entities (id, name, description, aliases, keywords)
      VALUES (1, 'OpenAI', 'AI company', '[]', '[]');
    INSERT INTO entities (id, name, description, aliases, keywords)
      VALUES (2, 'Microsoft', 'Tech company', '[]', '[]');
    INSERT INTO entities (id, name, description, aliases, keywords)
      VALUES (99, 'Lonely', 'No relations', '[]', '[]');

    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (10, 'OpenAI makes GPT', 'fact', 'active');
    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (20, 'Microsoft invested in OpenAI', 'fact', 'active');
    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (990, 'No relations here', 'fact', 'active');

    INSERT INTO sources (id, kind, normalized_url, original_url, raw_content, status, created_at)
      VALUES (1, 'external', 'https://example.com', 'https://example.com', NULL, 'confirmed', ${NOW_MS_SQL});

    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (1, 1, 10, 'new');
    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (1, 2, 20, 'new');
    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (1, 99, 990, 'new');

    INSERT INTO entity_relations (source_entity_id, target_entity_id, relation_type, description, source_id)
      VALUES (2, 1, 'collaborative', 'Invested $10B in OpenAI', 1);
  `);
}
