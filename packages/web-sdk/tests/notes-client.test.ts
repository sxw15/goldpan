// packages/web-sdk/tests/notes-client.test.ts
// Note SDK methods (createNote / listNotes / getNote / updateNote / deleteNote).
// 在 P6 之前这些方法叫 User-prefix。URL 路径仍为 /user-notes，保持 server contract 兼容。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoldpanClient } from '../src/client';
import type {
  CreateNoteInput,
  ListNotesParams,
  ListNotesResult,
  NoteDetail,
  NoteSourceRelation,
  NoteSubtype,
  UpdateNoteInput,
} from '../src/index';
import { type FetchHandler, installMockFetch } from './helpers/mock-fetch';

describe('GoldpanClient user notes (P1)', () => {
  let restore: () => void;
  let handler: FetchHandler;

  beforeEach(() => {
    handler = () => ({ status: 200, body: {} });
    const mock = installMockFetch((url, init) => handler(url, init));
    restore = mock.restore;
  });

  afterEach(() => {
    restore();
  });

  it('exports user-note types from the root entry', () => {
    const subtype: NoteSubtype = 'memo';
    const relation: NoteSourceRelation = 'reference';
    const createInput: CreateNoteInput = { content: 'x', subtype };
    const updateInput: UpdateNoteInput = { pinned: true };
    const params: ListNotesParams = { subtype, cursor: '100:1' };
    const detail: NoteDetail = {
      id: 1,
      content: createInput.content,
      contentTranslated: null,
      language: null,
      subtype,
      pinned: updateInput.pinned ?? false,
      archived: false,
      sourceMessageId: null,
      conversationId: null,
      tags: [],
      linkedEntities: [],
      linkedSources: [{ id: 2, relation, title: null, originalUrl: null }],
      dueAt: null,
      remindedAt: null,
      createdAt: 100,
      updatedAt: 100,
    };
    const result: ListNotesResult = { data: [detail], nextCursor: params.cursor as string };

    expect(result.data[0].subtype).toBe('memo');
    expect(result.data[0].linkedSources[0].relation).toBe('reference');
  });

  it('createNote POSTs JSON body to /user-notes', async () => {
    handler = (url, init) => {
      expect(url).toBe('http://test/user-notes');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ content: 'x', subtype: 'memo' }));
      return { status: 201, body: { id: 1, content: 'x', subtype: 'memo' } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const note = await client.createNote({ content: 'x', subtype: 'memo' });
    expect(note.id).toBe(1);
    expect(note.subtype).toBe('memo');
  });

  it('getNote GETs /user-notes/:id', async () => {
    handler = (url, init) => {
      expect(url).toBe('http://test/user-notes/7');
      expect(init?.method).toBe('GET');
      return { status: 200, body: { id: 7, content: 'note 7' } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const note = await client.getNote(7);
    expect(note.id).toBe(7);
  });

  it('getNote returns conversationId derived from sourceMessageId join', async () => {
    const fixture: NoteDetail = {
      id: 7,
      content: 'note',
      contentTranslated: null,
      language: null,
      subtype: 'memo',
      pinned: false,
      archived: false,
      sourceMessageId: 42,
      conversationId: 99,
      tags: [],
      linkedEntities: [{ id: 1, name: 'E1' }],
      linkedSources: [{ id: 11, relation: 'reference', title: 't', originalUrl: 'https://u' }],
      dueAt: null,
      remindedAt: null,
      createdAt: 0,
      updatedAt: 0,
    };
    handler = () => ({ status: 200, body: fixture });
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const out = await client.getNote(7);
    expect(out.conversationId).toBe(99);
    expect(out.sourceMessageId).toBe(42);
  });

  it('listNotes serializes filters into query string', async () => {
    handler = (url) => {
      expect(url).toContain('/user-notes');
      expect(url).toContain('subtype=memo%2Cnote');
      expect(url).toContain('limit=10');
      return { status: 200, body: { data: [], nextCursor: null } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const result = await client.listNotes({ subtype: ['memo', 'note'], limit: 10 });
    expect(result).toEqual({ data: [], nextCursor: null });
  });

  it('listNotes serializes single subtype + booleans', async () => {
    handler = (url) => {
      expect(url).toContain('subtype=memo');
      expect(url).toContain('pinned=true');
      expect(url).toContain('archived=false');
      return { status: 200, body: { data: [], nextCursor: null } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    await client.listNotes({ subtype: 'memo', pinned: true, archived: false });
  });

  it('updateNote PATCHes /user-notes/:id with body', async () => {
    handler = (url, init) => {
      expect(url).toBe('http://test/user-notes/3');
      expect(init?.method).toBe('PATCH');
      expect(init?.body).toBe(JSON.stringify({ pinned: true }));
      return { status: 200, body: { id: 3, pinned: true } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const note = await client.updateNote(3, { pinned: true });
    expect(note.pinned).toBe(true);
  });

  it('deleteNote DELETEs /user-notes/:id and resolves void on 204', async () => {
    handler = (url, init) => {
      expect(url).toBe('http://test/user-notes/5');
      expect(init?.method).toBe('DELETE');
      return { status: 204 };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    await expect(client.deleteNote(5)).resolves.toBeUndefined();
  });

  describe('promoteNote', () => {
    it('POSTs /user-notes/:id/promote and returns { taskId, sourceId }', async () => {
      handler = (url, init) => {
        expect(url).toBe('http://test/user-notes/7/promote');
        expect(init?.method).toBe('POST');
        return { status: 200, body: { taskId: 42, sourceId: 99 } };
      };
      const client = new GoldpanClient({ baseUrl: 'http://test' });
      const result = await client.promoteNote(7);
      expect(result).toEqual({ taskId: 42, sourceId: 99 });
    });

    it('throws GoldpanApiError on 400', async () => {
      handler = () => ({
        status: 400,
        body: { code: 'note_archived', message: 'note is archived' },
      });
      const client = new GoldpanClient({ baseUrl: 'http://test' });
      await expect(client.promoteNote(7)).rejects.toMatchObject({
        code: 'note_archived',
        status: 400,
      });
    });
  });

  it('translateNote POSTs /user-notes/:id/translate and returns contentTranslated', async () => {
    handler = (url, init) => {
      expect(url).toBe('http://test/user-notes/42/translate');
      expect(init?.method).toBe('POST');
      return { status: 200, body: { contentTranslated: 'Hello world' } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const result = await client.translateNote(42);
    expect(result.contentTranslated).toBe('Hello world');
  });

  it('translateNote surfaces 400 already_target_language as GoldpanApiError', async () => {
    handler = () => ({
      status: 400,
      body: { code: 'already_target_language', message: 'note is already in target' },
    });
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    await expect(client.translateNote(7)).rejects.toMatchObject({
      status: 400,
      code: 'already_target_language',
    });
  });
});

describe('GoldpanClient.markNoteReminded (P7.4)', () => {
  let restore: () => void;
  let handler: FetchHandler;

  beforeEach(() => {
    handler = () => ({ status: 200, body: { remindedAt: 0 } });
    const mock = installMockFetch((url, init) => handler(url, init));
    restore = mock.restore;
  });

  afterEach(() => restore());

  it('POSTs to /user-notes/:id/mark-reminded and returns remindedAt', async () => {
    handler = (url, init) => {
      expect(url).toBe('http://test/user-notes/42/mark-reminded');
      expect(init?.method).toBe('POST');
      return { status: 200, body: { remindedAt: 1_700_000_000_000 } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const result = await client.markNoteReminded(42);
    expect(result.remindedAt).toBe(1_700_000_000_000);
  });

  it('POSTs expectedDueAt when provided', async () => {
    handler = (url, init) => {
      expect(url).toBe('http://test/user-notes/42/mark-reminded');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ expectedDueAt: 1_700 }));
      return { status: 200, body: { remindedAt: 1_800 } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    const result = await client.markNoteReminded(42, { expectedDueAt: 1_700 });
    expect(result.remindedAt).toBe(1_800);
  });

  it('surfaces 404 as GoldpanApiError with note_not_found code', async () => {
    handler = () => ({
      status: 404,
      body: { code: 'note_not_found', message: 'gone' },
    });
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    await expect(client.markNoteReminded(7)).rejects.toMatchObject({
      status: 404,
      code: 'note_not_found',
    });
  });
});

describe('GoldpanClient.listNotes with P7.4 filters', () => {
  let restore: () => void;
  let handler: FetchHandler;

  beforeEach(() => {
    handler = () => ({ status: 200, body: { data: [], total: 0 } });
    const mock = installMockFetch((url, init) => handler(url, init));
    restore = mock.restore;
  });

  afterEach(() => restore());

  it('serializes dueBefore + hasReminder to query string', async () => {
    handler = (url) => {
      expect(url).toContain('subtype=memo');
      expect(url).toContain('dueBefore=1700');
      expect(url).toContain('hasReminder=true');
      return { status: 200, body: { data: [], total: 0 } };
    };
    const client = new GoldpanClient({ baseUrl: 'http://test' });
    await client.listNotes({ subtype: 'memo', dueBefore: 1700, hasReminder: true });
  });
});
