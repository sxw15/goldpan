import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteNotesRepository } from '../../src/db/repositories/notes.repository';
import { createNote } from '../../src/notes/create';
import { getNote } from '../../src/notes/get';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('getNote', () => {
  let t: TestDB;
  let repo: SqliteNotesRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteNotesRepository(t.db);
  });
  afterEach(() => t.cleanup());

  it('returns null for non-existent id', () => {
    expect(getNote(99999, { repo })).toBeNull();
  });

  it('returns full detail for an existing note', () => {
    const created = createNote(
      { content: 'test', subtype: 'memo', tags: ['t1'] },
      { db: t.db, repo },
    );

    const got = getNote(created.id, { repo });
    expect(got).not.toBeNull();
    expect(got?.id).toBe(created.id);
    expect(got?.content).toBe('test');
    expect(got?.subtype).toBe('memo');
    expect(got?.tags).toEqual(['t1']);
  });

  // P5 prerequisite: NoteDetail.conversationId derived from sourceMessageId join
  // (§8 sourceMessage 溯源 needs conversationId to render "来自对话 X 月 Y 日" link).
  it('returns conversationId when sourceMessageId points to a web default conversation message', () => {
    // Use raw better-sqlite3 client to seed conversations + conversation_messages
    // (mirrors the pattern in create.test.ts:91-97 — schema-level inserts without
    //  exporting the drizzle table refs from this test).
    const raw = (t.db as unknown as { $client: import('better-sqlite3').Database }).$client;
    raw.exec(`INSERT INTO conversations (session_key, channel_id) VALUES ('web:default', 'web')`);
    const convRow = raw.prepare(`SELECT id FROM conversations`).get() as { id: number };
    const msgRow = raw
      .prepare(
        `INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, ?, ?) RETURNING id`,
      )
      .get(convRow.id, 'user', 'hi') as { id: number };

    const note = createNote({ content: 'derived', sourceMessageId: msgRow.id }, { db: t.db, repo });

    const detail = getNote(note.id, { repo });
    expect(detail).not.toBeNull();
    expect(detail?.conversationId).toBe(convRow.id);
  });

  it('returns conversationId === null when sourceMessage belongs to a non-default web session', () => {
    const raw = (t.db as unknown as { $client: import('better-sqlite3').Database }).$client;
    raw.exec(`INSERT INTO conversations (session_key, channel_id) VALUES ('test-session', 'web')`);
    const convRow = raw.prepare(`SELECT id FROM conversations`).get() as { id: number };
    const msgRow = raw
      .prepare(
        `INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, ?, ?) RETURNING id`,
      )
      .get(convRow.id, 'user', 'hi') as { id: number };

    const note = createNote({ content: 'derived', sourceMessageId: msgRow.id }, { db: t.db, repo });

    const detail = getNote(note.id, { repo });
    expect(detail).not.toBeNull();
    expect(detail?.sourceMessageId).toBe(msgRow.id);
    expect(detail?.conversationId).toBeNull();
  });

  it('returns conversationId === null when sourceMessageId is null', () => {
    const note = createNote({ content: 'standalone' }, { db: t.db, repo });
    const detail = getNote(note.id, { repo });
    expect(detail).not.toBeNull();
    expect(detail?.conversationId).toBeNull();
  });

  // I8: IM-origin notes (channelId !== 'web') must NOT leak conversationId to
  // the web UI — web has no route to open telegram/feishu conversations, so a
  // non-null id would render a dead "来自对话" link. sourceMessageId still
  // persists for audit; only the front-end link is suppressed.
  it('returns conversationId === null when sourceMessage belongs to non-web channel', () => {
    const raw = (t.db as unknown as { $client: import('better-sqlite3').Database }).$client;
    raw.exec(
      `INSERT INTO conversations (session_key, channel_id) VALUES ('tg-session', 'telegram')`,
    );
    const convRow = raw.prepare(`SELECT id FROM conversations`).get() as { id: number };
    const msgRow = raw
      .prepare(
        `INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, ?, ?) RETURNING id`,
      )
      .get(convRow.id, 'user', 'from telegram') as { id: number };

    const note = createNote(
      { content: 'im-origin', sourceMessageId: msgRow.id },
      { db: t.db, repo },
    );

    const detail = getNote(note.id, { repo });
    expect(detail).not.toBeNull();
    expect(detail?.sourceMessageId).toBe(msgRow.id);
    expect(detail?.conversationId).toBeNull();
  });
});
