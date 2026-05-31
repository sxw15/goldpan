// monorepo/packages/core/tests/db/schema.test.ts

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection.js';
import * as schema from '../../src/db/schema.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

describe('Schema Integration', () => {
  let t: TestDB;

  beforeEach(() => {
    t = createTestDB();
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('SQLite pragmas', () => {
    it('has WAL journal mode', () => {
      const raw = getRawDatabase(t.db);
      const mode = raw.pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
    });

    it('has foreign keys enabled', () => {
      const raw = getRawDatabase(t.db);
      const fk = raw.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
    });

    it('has busy_timeout configured', () => {
      const raw = getRawDatabase(t.db);
      const timeout = raw.pragma('busy_timeout', { simple: true });
      expect(timeout).toBe(5000);
    });
  });

  describe('FK enforcement', () => {
    it('rejects entity_categories with non-existent entity', () => {
      const [cat] = t.db
        .insert(schema.categories)
        .values({
          name: 'FKTest',
          path: '/FKTest',
        })
        .returning()
        .all();
      expect(() => {
        t.db
          .insert(schema.entityCategories)
          .values({
            entityId: 999,
            categoryId: cat.id,
          })
          .run();
      }).toThrow(/FOREIGN KEY/);
    });

    it('cascades entity_categories on entity delete', () => {
      const [cat] = t.db
        .insert(schema.categories)
        .values({
          name: 'Test',
          path: '/Test',
        })
        .returning()
        .all();
      const [ent] = t.db
        .insert(schema.entities)
        .values({
          name: 'TestEntity',
        })
        .returning()
        .all();
      t.db
        .insert(schema.entityCategories)
        .values({
          entityId: ent.id,
          categoryId: cat.id,
        })
        .run();

      t.db.delete(schema.entities).where(sql`id = ${ent.id}`).run();
      const links = t.db.select().from(schema.entityCategories).all();
      expect(links).toHaveLength(0);
    });

    it('restricts parent category delete (self-reference RESTRICT)', () => {
      const [cat] = t.db
        .insert(schema.categories)
        .values({
          name: 'Parent',
          path: '/Parent',
        })
        .returning()
        .all();
      const [_child] = t.db
        .insert(schema.categories)
        .values({
          name: 'Child',
          path: '/Parent/Child',
          parentId: cat.id,
        })
        .returning()
        .all();

      expect(() => {
        t.db.delete(schema.categories).where(sql`id = ${cat.id}`).run();
      }).toThrow(/FOREIGN KEY/);
    });

    it('cascades entity_categories on category delete', () => {
      const [cat] = t.db
        .insert(schema.categories)
        .values({
          name: 'Temp',
          path: '/Temp',
        })
        .returning()
        .all();
      const [ent] = t.db
        .insert(schema.entities)
        .values({
          name: 'TempEntity',
        })
        .returning()
        .all();
      t.db
        .insert(schema.entityCategories)
        .values({
          entityId: ent.id,
          categoryId: cat.id,
        })
        .run();

      t.db.delete(schema.categories).where(sql`id = ${cat.id}`).run();
      const links = t.db.select().from(schema.entityCategories).all();
      expect(links).toHaveLength(0);
    });

    it('cascades source_entity_points on source delete', () => {
      const [ent] = t.db.insert(schema.entities).values({ name: 'E' }).returning().all();
      const [_cat] = t.db
        .insert(schema.categories)
        .values({ name: 'C', path: '/C' })
        .returning()
        .all();
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'external',
          normalizedUrl: 'https://example.com/sep-test',
          originalUrl: 'https://example.com/sep-test',
          status: 'processing',
        })
        .returning()
        .all();
      const [pt] = t.db
        .insert(schema.knowledgePoints)
        .values({
          type: 'fact',
          content: 'test for sep cascade',
        })
        .returning()
        .all();
      t.db
        .insert(schema.sourceEntityPoints)
        .values({
          sourceId: src.id,
          entityId: ent.id,
          pointId: pt.id,
          judgment: 'new',
        })
        .run();

      t.db.delete(schema.sources).where(sql`id = ${src.id}`).run();
      const seps = t.db.select().from(schema.sourceEntityPoints).all();
      expect(seps).toHaveLength(0);
    });

    it('restricts entity delete when referenced by source_entity_points', () => {
      const [ent] = t.db.insert(schema.entities).values({ name: 'E2' }).returning().all();
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'external',
          normalizedUrl: 'https://example.com/sep-restrict',
          originalUrl: 'https://example.com/sep-restrict',
          status: 'processing',
        })
        .returning()
        .all();
      const [pt] = t.db
        .insert(schema.knowledgePoints)
        .values({
          type: 'fact',
          content: 'test for restrict entity',
        })
        .returning()
        .all();
      t.db
        .insert(schema.sourceEntityPoints)
        .values({
          sourceId: src.id,
          entityId: ent.id,
          pointId: pt.id,
          judgment: 'new',
        })
        .run();

      expect(() => {
        t.db.delete(schema.entities).where(sql`id = ${ent.id}`).run();
      }).toThrow(/FOREIGN KEY/);
    });

    it('restricts knowledge_point delete when referenced by source_entity_points', () => {
      const [ent] = t.db.insert(schema.entities).values({ name: 'E3' }).returning().all();
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'external',
          normalizedUrl: 'https://example.com/sep-pt-restrict',
          originalUrl: 'https://example.com/sep-pt-restrict',
          status: 'processing',
        })
        .returning()
        .all();
      const [pt] = t.db
        .insert(schema.knowledgePoints)
        .values({
          type: 'fact',
          content: 'test for restrict point',
        })
        .returning()
        .all();
      t.db
        .insert(schema.sourceEntityPoints)
        .values({
          sourceId: src.id,
          entityId: ent.id,
          pointId: pt.id,
          judgment: 'new',
        })
        .run();

      expect(() => {
        t.db.delete(schema.knowledgePoints).where(sql`id = ${pt.id}`).run();
      }).toThrow(/FOREIGN KEY/);
    });

    it('sets null on event_logs.entityId when entity is deleted', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      const [ent] = t.db.insert(schema.entities).values({ name: 'E' }).returning().all();
      t.db
        .insert(schema.eventLogs)
        .values({
          sourceId: src.id,
          action: 'entity_created',
          entityId: ent.id,
        })
        .run();

      t.db.delete(schema.entities).where(sql`id = ${ent.id}`).run();
      const logs = t.db.select().from(schema.eventLogs).all();
      expect(logs[0].entityId).toBeNull();
    });

    it('sets null on submission_logs.sourceId when source is deleted', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      const [task] = t.db
        .insert(schema.processingTasks)
        .values({
          sourceId: src.id,
          type: 'pipeline',
          inputType: 'url',
          status: 'pending',
        })
        .returning()
        .all();
      t.db
        .insert(schema.submissionLogs)
        .values({
          rawInput: 'test',
          result: 'accepted',
          sourceId: src.id,
          taskId: task.id,
        })
        .run();

      t.db.delete(schema.processingTasks).where(sql`id = ${task.id}`).run();
      t.db.delete(schema.sources).where(sql`id = ${src.id}`).run();
      const logs = t.db.select().from(schema.submissionLogs).all();
      expect(logs[0].sourceId).toBeNull();
    });
  });

  describe('CHECK constraints', () => {
    it('rejects invalid source status', () => {
      expect(() => {
        t.db
          .insert(schema.sources)
          .values({
            kind: 'external',
            normalizedUrl: 'https://example.com',
            originalUrl: 'https://example.com',
            status: 'invalid_status',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects user source with URL', () => {
      expect(() => {
        t.db
          .insert(schema.sources)
          .values({
            kind: 'user',
            normalizedUrl: 'https://should-not-have-url.com',
            originalUrl: 'https://should-not-have-url.com',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects external source without URL', () => {
      expect(() => {
        t.db
          .insert(schema.sources)
          .values({
            kind: 'external',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects invalid knowledge_point type', () => {
      expect(() => {
        t.db
          .insert(schema.knowledgePoints)
          .values({
            content: 'test',
            type: 'invalid',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects done task without result', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();

      expect(() => {
        t.db
          .insert(schema.processingTasks)
          .values({
            sourceId: src.id,
            type: 'pipeline',
            status: 'done',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects non-accepted submission without reason', () => {
      expect(() => {
        t.db
          .insert(schema.submissionLogs)
          .values({
            rawInput: 'test',
            result: 'rejected',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects user source without rawContent', () => {
      expect(() => {
        t.db
          .insert(schema.sources)
          .values({
            kind: 'user',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it.todo(
      'accepted submission requires sourceId+taskId (enforced at runtime in SqliteSubmissionLogRepository)',
    );

    it('rejects invalid JSON in entities.aliases', () => {
      expect(() => {
        t.db
          .insert(schema.entities)
          .values({
            name: 'Test',
            aliases: 'not-json',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects non-array JSON in entities.aliases', () => {
      expect(() => {
        t.db
          .insert(schema.entities)
          .values({
            name: 'Test',
            aliases: '{"not": "array"}',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects invalid event_logs action', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      expect(() => {
        t.db
          .insert(schema.eventLogs)
          .values({
            sourceId: src.id,
            action: 'invalid_action' as any,
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects invalid JSON in processing_tasks result', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      expect(() => {
        t.db
          .insert(schema.processingTasks)
          .values({
            sourceId: src.id,
            type: 'pipeline',
            status: 'done',
            result: 'not-valid-json{{{',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects array JSON in sources.metadata', () => {
      expect(() => {
        t.db
          .insert(schema.sources)
          .values({
            kind: 'user',
            rawContent: 'test',
            metadata: '[1,2,3]',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects scalar JSON in sources.metadata', () => {
      expect(() => {
        t.db
          .insert(schema.sources)
          .values({
            kind: 'user',
            rawContent: 'test',
            metadata: '"just a string"',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects invalid pipeline step', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      expect(() => {
        t.db
          .insert(schema.processingTasks)
          .values({
            sourceId: src.id,
            type: 'pipeline',
            status: 'processing',
            pipelineStep: 'invalid_step' as any,
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects invalid error_kind value', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      expect(() => {
        t.db
          .insert(schema.processingTasks)
          .values({
            sourceId: src.id,
            type: 'pipeline',
            status: 'error',
            errorMessage: 'fail',
            errorKind: 'bad_kind' as any,
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('rejects error status without error_kind', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      expect(() => {
        t.db
          .insert(schema.processingTasks)
          .values({
            sourceId: src.id,
            type: 'pipeline',
            status: 'error',
            errorMessage: 'fail',
          })
          .run();
      }).toThrow(/CHECK/);
    });

    it('allows valid error_kind values', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      const validKinds = [
        'schema_validation',
        'content_policy',
        'content_length',
        'rate_limit',
        'timeout',
        'unknown',
      ] as const;
      for (const kind of validKinds) {
        t.db
          .insert(schema.processingTasks)
          .values({
            sourceId: src.id,
            type: 'pipeline',
            status: 'error',
            errorMessage: `fail ${kind}`,
            errorKind: kind,
          })
          .run();
      }
    });
  });

  describe('Partial unique index', () => {
    it('prevents duplicate active URLs', () => {
      t.db
        .insert(schema.sources)
        .values({
          kind: 'external',
          normalizedUrl: 'https://example.com/article',
          originalUrl: 'https://example.com/article',
          status: 'processing',
        })
        .run();

      expect(() => {
        t.db
          .insert(schema.sources)
          .values({
            kind: 'external',
            normalizedUrl: 'https://example.com/article',
            originalUrl: 'https://example.com/article',
            status: 'processing',
          })
          .run();
      }).toThrow(/UNIQUE/);
    });

    it('allows same URL when existing is failed', () => {
      t.db
        .insert(schema.sources)
        .values({
          kind: 'external',
          normalizedUrl: 'https://example.com/article',
          originalUrl: 'https://example.com/article',
          status: 'failed',
        })
        .run();

      t.db
        .insert(schema.sources)
        .values({
          kind: 'external',
          normalizedUrl: 'https://example.com/article',
          originalUrl: 'https://example.com/article',
          status: 'processing',
        })
        .run();

      const count = t.db.select().from(schema.sources).all();
      expect(count).toHaveLength(2);
    });

    it('allows same URL when existing is confirmed_empty', () => {
      t.db
        .insert(schema.sources)
        .values({
          kind: 'external',
          normalizedUrl: 'https://example.com/article',
          originalUrl: 'https://example.com/article',
          status: 'confirmed_empty',
        })
        .run();

      t.db
        .insert(schema.sources)
        .values({
          kind: 'external',
          normalizedUrl: 'https://example.com/article',
          originalUrl: 'https://example.com/article',
          status: 'processing',
        })
        .run();

      const count = t.db.select().from(schema.sources).all();
      expect(count).toHaveLength(2);
    });

    it('prevents duplicate when existing is confirmed (active)', () => {
      t.db
        .insert(schema.sources)
        .values({
          kind: 'external',
          normalizedUrl: 'https://example.com/article',
          originalUrl: 'https://example.com/article',
          status: 'confirmed',
        })
        .run();

      expect(() => {
        t.db
          .insert(schema.sources)
          .values({
            kind: 'external',
            normalizedUrl: 'https://example.com/article',
            originalUrl: 'https://example.com/article',
            status: 'processing',
          })
          .run();
      }).toThrow(/UNIQUE/);
    });
  });

  describe('Defaults', () => {
    it('entities default aliases and keywords to empty arrays', () => {
      const [ent] = t.db
        .insert(schema.entities)
        .values({
          name: 'Test',
        })
        .returning()
        .all();
      expect(ent.aliases).toBe('[]');
      expect(ent.keywords).toBe('[]');
    });

    it('sources default status to processing', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      expect(src.status).toBe('processing');
    });

    it('knowledge_points default status to active', () => {
      const [kp] = t.db
        .insert(schema.knowledgePoints)
        .values({
          content: 'test fact',
          type: 'fact',
        })
        .returning()
        .all();
      expect(kp.status).toBe('active');
    });
  });
});
