// monorepo/packages/core/tests/db/transaction.test.ts

import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection.js';
import * as schema from '../../src/db/schema.js';
import { NOW_MS, NOW_MS_SQL } from '../../src/db/sql-fragments.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

describe('Transaction Primitives', () => {
  let t: TestDB;

  beforeEach(() => {
    t = createTestDB();
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('db.transaction() — standard Drizzle transactions', () => {
    it('commits on success', () => {
      t.db.transaction((tx) => {
        tx.insert(schema.sources)
          .values({
            kind: 'user',
            rawContent: 'test1',
          })
          .run();
        tx.insert(schema.sources)
          .values({
            kind: 'user',
            rawContent: 'test2',
          })
          .run();
      });

      const all = t.db.select().from(schema.sources).all();
      expect(all).toHaveLength(2);
    });

    it('rolls back on error', () => {
      expect(() => {
        t.db.transaction((tx) => {
          tx.insert(schema.sources)
            .values({
              kind: 'user',
              rawContent: 'before-error',
            })
            .run();
          throw new Error('simulated failure');
        });
      }).toThrow('simulated failure');

      const all = t.db.select().from(schema.sources).all();
      expect(all).toHaveLength(0);
    });

    it('rolls back on constraint violation', () => {
      const [_cat] = t.db
        .insert(schema.categories)
        .values({
          name: 'Test',
          path: '/Test',
        })
        .returning()
        .all();

      expect(() => {
        t.db.transaction((tx) => {
          tx.insert(schema.categories)
            .values({
              name: 'Another',
              path: '/Another',
            })
            .run();
          tx.insert(schema.categories)
            .values({
              name: 'Dup',
              path: '/Test',
            })
            .run();
        });
      }).toThrow();

      const cats = t.db.select().from(schema.categories).all();
      expect(cats).toHaveLength(1);
      expect(cats[0].path).toBe('/Test');
    });
  });

  describe('BEGIN IMMEDIATE — worker task claiming', () => {
    it('claims a task atomically', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      t.db
        .insert(schema.processingTasks)
        .values({
          sourceId: src.id,
          type: 'pipeline',
          status: 'pending',
        })
        .run();

      const raw = getRawDatabase(t.db);
      raw.exec('BEGIN IMMEDIATE');
      try {
        const claimed = raw
          .prepare(`
          UPDATE processing_tasks SET status = 'processing', updated_at = ${NOW_MS_SQL}
          WHERE id = (
            SELECT id FROM processing_tasks
            WHERE status = 'pending' AND type = 'pipeline'
            ORDER BY created_at ASC, id ASC LIMIT 1
          )
        `)
          .run();

        expect(claimed.changes).toBe(1);
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }

      const tasks = t.db.select().from(schema.processingTasks).all();
      expect(tasks[0].status).toBe('processing');
    });

    it('returns 0 changes when no tasks available', () => {
      const raw = getRawDatabase(t.db);
      raw.exec('BEGIN IMMEDIATE');
      try {
        const claimed = raw
          .prepare(`
          UPDATE processing_tasks SET status = 'processing', updated_at = ${NOW_MS_SQL}
          WHERE id = (
            SELECT id FROM processing_tasks
            WHERE status = 'pending' AND type = 'pipeline'
            ORDER BY created_at ASC, id ASC LIMIT 1
          )
        `)
          .run();

        expect(claimed.changes).toBe(0);
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    });

    it('blocks concurrent claim on second connection', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
        })
        .returning()
        .all();
      t.db
        .insert(schema.processingTasks)
        .values({
          sourceId: src.id,
          type: 'pipeline',
          status: 'pending',
        })
        .run();

      const raw1 = getRawDatabase(t.db);
      raw1.exec('BEGIN IMMEDIATE');

      const raw2 = new Database(t.dbPath);
      raw2.pragma('busy_timeout = 0');

      expect(() => {
        raw2.exec('BEGIN IMMEDIATE');
      }).toThrow(/database is locked/);

      raw1.exec('ROLLBACK');
      raw2.close();
    });
  });

  describe('Atomic source + task creation (submission flow)', () => {
    it('creates source and task atomically', () => {
      t.db.transaction((tx) => {
        const [src] = tx
          .insert(schema.sources)
          .values({
            kind: 'external',
            normalizedUrl: 'https://example.com/article',
            originalUrl: 'https://example.com/article',
            status: 'processing',
          })
          .returning()
          .all();

        const [task] = tx
          .insert(schema.processingTasks)
          .values({
            sourceId: src.id,
            type: 'pipeline',
            inputType: 'url',
            status: 'pending',
          })
          .returning()
          .all();

        tx.insert(schema.submissionLogs)
          .values({
            rawInput: 'https://example.com/article',
            result: 'accepted',
            sourceId: src.id,
            taskId: task.id,
          })
          .run();
      });

      const sources = t.db.select().from(schema.sources).all();
      const tasks = t.db.select().from(schema.processingTasks).all();
      const logs = t.db.select().from(schema.submissionLogs).all();

      expect(sources).toHaveLength(1);
      expect(tasks).toHaveLength(1);
      expect(logs).toHaveLength(1);
      expect(tasks[0].sourceId).toBe(sources[0].id);
    });
  });

  describe('Atomic failure handling (task error + source failed)', () => {
    it('updates task and source status atomically', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'user',
          rawContent: 'test',
          status: 'processing',
        })
        .returning()
        .all();
      const [task] = t.db
        .insert(schema.processingTasks)
        .values({
          sourceId: src.id,
          type: 'pipeline',
          status: 'processing',
        })
        .returning()
        .all();

      t.db.transaction((tx) => {
        tx.update(schema.processingTasks)
          .set({
            status: 'error',
            pipelineStep: 'extracting',
            errorMessage: 'LLM timeout',
            errorKind: 'unknown',
            updatedAt: NOW_MS,
          })
          .where(sql`id = ${task.id}`)
          .run();

        tx.update(schema.sources)
          .set({
            status: 'failed',
            updatedAt: NOW_MS,
          })
          .where(sql`id = ${src.id}`)
          .run();
      });

      const updatedTask = t.db.select().from(schema.processingTasks).all()[0];
      const updatedSrc = t.db.select().from(schema.sources).all()[0];

      expect(updatedTask.status).toBe('error');
      expect(updatedTask.errorMessage).toBe('LLM timeout');
      expect(updatedSrc.status).toBe('failed');
    });
  });
});
