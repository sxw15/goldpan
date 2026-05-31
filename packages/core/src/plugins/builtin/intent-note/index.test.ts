import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ILogObj, Logger } from 'tslog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type DrizzleDB, getRawDatabase } from '../../../db/connection';
import { ensureFtsTables } from '../../../db/fts';
import { runMigrations } from '../../../db/migrate';
import { SqliteKnowledgeRepository } from '../../../db/repositories/knowledge.repository';
import { SqliteNotesRepository } from '../../../db/repositories/notes.repository';
import { SqliteSourceRepository } from '../../../db/repositories/source.repository';
import { entities, knowledgePoints, sourceEntityPoints, sources } from '../../../db/schema';
import { utcNowMs } from '../../../db/timestamp';
import type { IntentExecutionContext } from '../../types';
import { intentNotePlugin } from './index';

interface TestDB {
  db: DrizzleDB;
  cleanup: () => void;
}

/**
 * Inline copy of `tests/helpers/test-db.ts` — we can't import across the
 * `src/` rootDir, so we duplicate the minimal bootstrap that drives the
 * Drizzle migrations + FTS tables for this plugin test.
 */
function createTestDB(): TestDB {
  const tmpDir = mkdtempSync(join(tmpdir(), 'goldpan-intent-note-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const db = createDatabase(dbPath);

  // Migrations live at packages/core/drizzle/ — resolve from this file's URL.
  const migrationsFolder = join(import.meta.dirname, '../../../../drizzle');
  runMigrations(db, migrationsFolder);

  const raw = getRawDatabase(db);
  ensureFtsTables(raw, 'en');

  return {
    db,
    cleanup: () => {
      try {
        raw.close();
      } catch {
        /* already closed */
      }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function silentLogger(): Logger<ILogObj> {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    silly: () => undefined,
    getSubLogger: () => silentLogger(),
  } as unknown as Logger<ILogObj>;
}

/** Insert a confirmed (terminal) source. */
function seedConfirmedSource(db: DrizzleDB, opts: { title?: string } = {}): number {
  const now = utcNowMs();
  const row = db
    .insert(sources)
    .values({
      kind: 'user',
      rawContent: 'seeded content',
      title: opts.title ?? null,
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: sources.id })
    .all();
  return row[0].id;
}

/** Insert a source still mid-pipeline (status='processing'). */
function seedProcessingSource(db: DrizzleDB, opts: { title?: string } = {}): number {
  const now = utcNowMs();
  const row = db
    .insert(sources)
    .values({
      kind: 'user',
      rawContent: 'seeded content',
      title: opts.title ?? null,
      status: 'processing',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: sources.id })
    .all();
  return row[0].id;
}

/**
 * Insert an entity + knowledge_point + source_entity_points row so the source
 * has an associated entity discoverable via KnowledgeRepository.getEntityIdsForSource.
 */
function seedEntityLinkedToSource(db: DrizzleDB, sourceId: number, name: string): number {
  const now = utcNowMs();
  const entRow = db
    .insert(entities)
    .values({ name, createdAt: now, updatedAt: now })
    .returning({ id: entities.id })
    .all();
  const entityId = entRow[0].id;

  const pointRow = db
    .insert(knowledgePoints)
    .values({ content: 'kp', type: 'fact', createdAt: now, updatedAt: now })
    .returning({ id: knowledgePoints.id })
    .all();
  const pointId = pointRow[0].id;

  db.insert(sourceEntityPoints)
    .values({ sourceId, entityId, pointId, judgment: 'new', createdAt: now })
    .run();

  return entityId;
}

function makeCtx(
  tdb: TestDB,
  overrides: Partial<IntentExecutionContext> = {},
): IntentExecutionContext {
  const notesRepo = new SqliteNotesRepository(tdb.db);
  const sourceRepo = new SqliteSourceRepository(tdb.db);
  const knowledgeRepo = new SqliteKnowledgeRepository(tdb.db);
  return {
    logger: silentLogger(),
    // intent-note plugin 不读 config 任何字段，传空对象即可。
    config: {} as never,
    language: 'en',
    db: tdb.db,
    repos: {
      llmCall: { record: vi.fn() } as never,
      submissionLog: {} as never,
      knowledge: knowledgeRepo,
      category: {} as never,
      notes: notesRepo,
      source: sourceRepo,
      conversation: {} as never,
    },
    callLlm: vi.fn() as never,
    llmCallRepo: { record: vi.fn() } as never,
    logPayloads: false,
    llmTimeout: 10000,
    conversation: {
      sessionKey: 't',
      conversationId: 1,
      channelId: 'web',
      recentMessages: [],
      messageWindowSize: 6,
      startedAt: new Date(),
    },
    ...overrides,
  };
}

describe('intentNotePlugin', () => {
  let tdb: TestDB;

  beforeEach(() => {
    tdb = createTestDB();
  });

  afterEach(() => {
    tdb.cleanup();
  });

  it('create_note 写入 notes 表（默认 subtype=note）', async () => {
    const ctx = makeCtx(tdb);
    const result = await intentNotePlugin.execute('create_note', '今天 X 发布', ctx);
    expect(result.type).toBe('note');
    if (result.type === 'note') {
      expect(result.detail.content).toBe('今天 X 发布');
      expect(result.detail.subtype).toBe('note');
    }
  });

  it('classifier 传 noteSubtype=memo 时透传到 note 行', async () => {
    const ctx = makeCtx(tdb, { noteSubtype: 'memo' });
    const result = await intentNotePlugin.execute('create_note', '明天提交 PR', ctx);
    expect(result.type).toBe('note');
    if (result.type === 'note') {
      expect(result.detail.subtype).toBe('memo');
    }
  });

  it('linkedSourceId ∈ recentMessages 时关联 source + 反查 entity', async () => {
    const sourceId = seedConfirmedSource(tdb.db, { title: 't' });
    const entityId = seedEntityLinkedToSource(tdb.db, sourceId, 'X Corp');

    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: [
          {
            id: 1,
            role: 'assistant',
            content: 'submitted',
            createdAt: new Date(),
            metadata: { sourceId },
          },
        ],
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });

    const result = await intentNotePlugin.execute('create_note', '关于这家公司的想法', ctx);
    expect(result.type).toBe('note');
    if (result.type === 'note') {
      expect(result.detail.linkedSources).toHaveLength(1);
      expect(result.detail.linkedSources[0]?.id).toBe(sourceId);
      expect(result.detail.linkedEntities).toContainEqual(
        expect.objectContaining({ id: entityId }),
      );
    }
  });

  it('信任 ctx.linkedSourceId（B2: 校验已在 handleInput 中央化）', async () => {
    // B2 后 plugin 不再做 mention check —— handleInput 在构建 IntentExecutionContext
    // 时已校验 ctx.linkedSourceId ∈ recentMessages，传到这里的值就是 trusted。
    // 跨 conversation 攻击的回归测试在 tests/input.test.ts。
    const sourceId = seedConfirmedSource(tdb.db, { title: 't' });
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: [],
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const result = await intentNotePlugin.execute('create_note', 'hi', ctx);
    expect(result.type).toBe('note');
    if (result.type === 'note') {
      expect(result.detail.linkedSources).toHaveLength(1);
      expect(result.detail.linkedSources[0]?.id).toBe(sourceId);
    }
  });

  it('linkedSourceId 指向的 source 还在 pipeline（status=processing）→ linkedEntities 留空', async () => {
    const sourceId = seedProcessingSource(tdb.db, { title: 't' });
    const ctx = makeCtx(tdb, {
      linkedSourceId: sourceId,
      conversation: {
        sessionKey: 't',
        conversationId: 1,
        channelId: 'web',
        recentMessages: [
          {
            id: 1,
            role: 'assistant',
            content: 'submitted',
            createdAt: new Date(),
            metadata: { sourceId },
          },
        ],
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    const result = await intentNotePlugin.execute('create_note', 'note about it', ctx);
    expect(result.type).toBe('note');
    if (result.type === 'note') {
      // source 关联建立，但 entity 留空（等 deferred resolver 在 P4 回填）
      expect(result.detail.linkedSources).toHaveLength(1);
      expect(result.detail.linkedEntities).toHaveLength(0);
    }
  });

  it('currentUserMessageId 透传到 note.sourceMessageId', async () => {
    // 先在 conversation_messages 里插入一条真实消息（sourceMessageId 有 FK 约束）
    const raw = (tdb.db as unknown as { $client: import('better-sqlite3').Database }).$client;
    raw.exec(`INSERT INTO conversations (session_key, channel_id) VALUES ('s', 'web')`);
    const convRow = raw.prepare(`SELECT id FROM conversations`).get() as { id: number };
    const msgRow = raw
      .prepare(
        `INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, ?, ?) RETURNING id`,
      )
      .get(convRow.id, 'user', 'q') as { id: number };

    const ctx = makeCtx(tdb, { currentUserMessageId: msgRow.id });
    const result = await intentNotePlugin.execute('create_note', 'q', ctx);
    expect(result.type).toBe('note');
    if (result.type === 'note') {
      expect(result.detail.sourceMessageId).toBe(msgRow.id);
    }
  });
});
