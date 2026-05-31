import type Database from 'better-sqlite3';
import type { Language } from '../i18n/types';

const FTS_META_KEY = 'fts_tokenizer';

const ALLOWED_TOKENIZERS = ['trigram', 'unicode61'] as const;
type Tokenizer = (typeof ALLOWED_TOKENIZERS)[number];

const TOKENIZER_SQL: Record<Tokenizer, string> = {
  trigram: "tokenize='trigram'",
  unicode61: "tokenize='unicode61'",
};

function tokenizerForLanguage(language: Language): Tokenizer {
  return language === 'zh' ? 'trigram' : 'unicode61';
}

/** Unpack a JSON array into space-separated text for FTS indexing. */
function jsonArrayToText(column: string): string {
  return `COALESCE((SELECT group_concat(je.value, ' ') FROM json_each(${column}) je), '')`;
}

/**
 * Ensure FTS5 virtual tables and content-sync triggers exist with the correct
 * tokenizer for the configured language. Runs after migrations and language lock.
 *
 * - `zh` → trigram (CJK substring matching)
 * - `en` → unicode61 (word-boundary tokenization)
 *
 * Idempotent: if the tables already exist with the expected tokenizer, no-op.
 * If the tokenizer changed (shouldn't happen due to language lock, but safe),
 * drops and recreates.
 */
export function ensureFtsTables(rawDb: Database.Database, language: Language): void {
  const tokenizer = tokenizerForLanguage(language);
  const tokenizeClause = TOKENIZER_SQL[tokenizer];
  const expectedMeta = `${tokenizer}_v4`;

  // Check if FTS tables already exist with the correct tokenizer
  const row = rawDb.prepare('SELECT value FROM db_metadata WHERE key = ?').get(FTS_META_KEY) as
    | { value: string }
    | undefined;

  if (row?.value === expectedMeta) return;

  // Wrap all DDL + DML in a transaction to avoid partial-failure states
  // where metadata says "done" but rebuild never ran.
  rawDb
    .transaction(() => {
      rawDb.exec(`
      DROP TRIGGER IF EXISTS entities_fts_insert;
      DROP TRIGGER IF EXISTS entities_fts_update;
      DROP TRIGGER IF EXISTS entities_fts_delete;
      DROP TRIGGER IF EXISTS knowledge_points_fts_insert;
      DROP TRIGGER IF EXISTS knowledge_points_fts_update;
      DROP TRIGGER IF EXISTS knowledge_points_fts_delete;
      DROP TRIGGER IF EXISTS sources_fts_insert;
      DROP TRIGGER IF EXISTS sources_fts_update;
      DROP TRIGGER IF EXISTS sources_fts_delete;
      DROP TRIGGER IF EXISTS notes_fts_insert;
      DROP TRIGGER IF EXISTS notes_fts_update;
      DROP TRIGGER IF EXISTS notes_fts_delete;
      DROP TABLE IF EXISTS entities_fts;
      DROP TABLE IF EXISTS knowledge_points_fts;
      DROP TABLE IF EXISTS sources_fts;
      DROP TABLE IF EXISTS notes_fts;
    `);

      // Create FTS5 tables with language-appropriate tokenizer
      rawDb.exec(`
      CREATE VIRTUAL TABLE entities_fts USING fts5(
        name, description, aliases, keywords,
        content='entities', content_rowid='id',
        ${tokenizeClause}
      );
      CREATE VIRTUAL TABLE knowledge_points_fts USING fts5(
        content,
        content='knowledge_points', content_rowid='id',
        ${tokenizeClause}
      );
      CREATE VIRTUAL TABLE sources_fts USING fts5(
        title, raw_content,
        content='sources', content_rowid='id',
        ${tokenizeClause}
      );
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        content, content_translated,
        content='notes', content_rowid='id',
        ${tokenizeClause}
      );
    `);

      // Content-sync triggers for entities (unpack JSON arrays for clean FTS indexing)
      rawDb.exec(`
      CREATE TRIGGER entities_fts_insert AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, name, description, aliases, keywords)
        VALUES (new.id, new.name, COALESCE(new.description, ''),
                ${jsonArrayToText('new.aliases')},
                ${jsonArrayToText('new.keywords')});
      END;

      CREATE TRIGGER entities_fts_update AFTER UPDATE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, description, aliases, keywords)
        VALUES ('delete', old.id, old.name, COALESCE(old.description, ''),
                ${jsonArrayToText('old.aliases')},
                ${jsonArrayToText('old.keywords')});
        INSERT INTO entities_fts(rowid, name, description, aliases, keywords)
        VALUES (new.id, new.name, COALESCE(new.description, ''),
                ${jsonArrayToText('new.aliases')},
                ${jsonArrayToText('new.keywords')});
      END;

      CREATE TRIGGER entities_fts_delete AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, description, aliases, keywords)
        VALUES ('delete', old.id, old.name, COALESCE(old.description, ''),
                ${jsonArrayToText('old.aliases')},
                ${jsonArrayToText('old.keywords')});
      END;
    `);

      // Content-sync triggers for knowledge_points (only active points)
      rawDb.exec(`
      CREATE TRIGGER knowledge_points_fts_insert AFTER INSERT ON knowledge_points
        WHEN new.status = 'active' BEGIN
        INSERT INTO knowledge_points_fts(rowid, content)
        VALUES (new.id, new.content);
      END;

      CREATE TRIGGER knowledge_points_fts_update AFTER UPDATE ON knowledge_points BEGIN
        INSERT INTO knowledge_points_fts(knowledge_points_fts, rowid, content)
        SELECT 'delete', old.id, old.content WHERE old.status = 'active';
        INSERT INTO knowledge_points_fts(rowid, content)
        SELECT new.id, new.content WHERE new.status = 'active';
      END;

      CREATE TRIGGER knowledge_points_fts_delete AFTER DELETE ON knowledge_points
        WHEN old.status = 'active' BEGIN
        INSERT INTO knowledge_points_fts(knowledge_points_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;
    `);

      // Content-sync triggers for sources (only confirmed/confirmed_empty)
      rawDb.exec(`
      CREATE TRIGGER sources_fts_insert AFTER INSERT ON sources
        WHEN new.status IN ('confirmed', 'confirmed_empty') BEGIN
        INSERT INTO sources_fts(rowid, title, raw_content)
        VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.raw_content, ''));
      END;

      CREATE TRIGGER sources_fts_update AFTER UPDATE ON sources BEGIN
        INSERT INTO sources_fts(sources_fts, rowid, title, raw_content)
        SELECT 'delete', old.id, COALESCE(old.title, ''), COALESCE(old.raw_content, '')
        WHERE old.status IN ('confirmed', 'confirmed_empty');
        INSERT INTO sources_fts(rowid, title, raw_content)
        SELECT new.id, COALESCE(new.title, ''), COALESCE(new.raw_content, '')
        WHERE new.status IN ('confirmed', 'confirmed_empty');
      END;

      CREATE TRIGGER sources_fts_delete AFTER DELETE ON sources
        WHEN old.status IN ('confirmed', 'confirmed_empty') BEGIN
        INSERT INTO sources_fts(sources_fts, rowid, title, raw_content)
        VALUES('delete', old.id, COALESCE(old.title, ''), COALESCE(old.raw_content, ''));
      END;
    `);

      // Content-sync triggers for notes (only non-archived).
      // Same skip-on-archived semantics as sources_fts uses for unconfirmed —
      // FTS should only index user-visible content.
      rawDb.exec(`
      CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes
        WHEN new.archived = 0 BEGIN
        INSERT INTO notes_fts(rowid, content, content_translated)
        VALUES (new.id, new.content, COALESCE(new.content_translated, ''));
      END;

      CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, content, content_translated)
        SELECT 'delete', old.id, old.content, COALESCE(old.content_translated, '')
        WHERE old.archived = 0;
        INSERT INTO notes_fts(rowid, content, content_translated)
        SELECT new.id, new.content, COALESCE(new.content_translated, '')
        WHERE new.archived = 0;
      END;

      CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes
        WHEN old.archived = 0 BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, content, content_translated)
        VALUES ('delete', old.id, old.content, COALESCE(old.content_translated, ''));
      END;
    `);

      // Populate FTS from existing data (all entities — triggers index on insert,
      // so rebuild must match trigger behavior; search-time filtering handles correctness)
      rawDb.exec(`
      INSERT INTO entities_fts(rowid, name, description, aliases, keywords)
      SELECT e.id, e.name, COALESCE(e.description, ''),
             ${jsonArrayToText('e.aliases')},
             ${jsonArrayToText('e.keywords')}
      FROM entities e;
    `);
      rawDb.exec(`
      INSERT INTO knowledge_points_fts(rowid, content)
      SELECT id, content FROM knowledge_points WHERE status = 'active';
    `);
      rawDb.exec(`
      INSERT INTO sources_fts(rowid, title, raw_content)
      SELECT id, COALESCE(title, ''), COALESCE(raw_content, '')
      FROM sources
      WHERE status IN ('confirmed', 'confirmed_empty');
    `);
      rawDb.exec(`
      INSERT INTO notes_fts(rowid, content, content_translated)
      SELECT id, content, COALESCE(content_translated, '')
      FROM notes
      WHERE archived = 0;
    `);

      // Record tokenizer metadata
      rawDb
        .prepare(
          `INSERT INTO db_metadata(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(FTS_META_KEY, expectedMeta);
    })
    .immediate();
}
