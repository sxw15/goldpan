import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteNotesRepository } from '../../src/db/repositories/notes.repository';
import type { LlmCallRepository } from '../../src/db/repositories/types';
import { notes } from '../../src/db/schema';
import { type TranslateNoteErrorCode, translateNote } from '../../src/notes/translate';
import type { CallLlmFn } from '../../src/pipeline/types';
import { createTestDB, type TestDB } from '../helpers/test-db';

function makeStubCallLlm(translated: string): CallLlmFn {
  return vi.fn(async () => ({
    translations: [{ id: 'note', translated }],
  })) as unknown as CallLlmFn;
}

function makeRejectingCallLlm(err: Error): CallLlmFn {
  return vi.fn(async () => {
    throw err;
  }) as unknown as CallLlmFn;
}

function noopLlmRepo(): LlmCallRepository {
  return {} as LlmCallRepository;
}

describe('translateNote', () => {
  let t: TestDB;
  let notesRepo: SqliteNotesRepository;

  beforeEach(() => {
    t = createTestDB();
    notesRepo = new SqliteNotesRepository(t.db);
  });

  afterEach(() => t.cleanup());

  const baseDeps = () => ({
    notesRepo,
    db: t.db,
    llmCallRepo: noopLlmRepo(),
    language: 'en' as const,
    logPayloads: false,
  });

  it('throws note_not_found when note id does not exist', async () => {
    await expect(
      translateNote(9999, { ...baseDeps(), callLlm: makeStubCallLlm('x') }),
    ).rejects.toMatchObject({
      name: 'TranslateNoteError',
      code: 'note_not_found' satisfies TranslateNoteErrorCode,
    });
  });

  it('throws note_empty when content is whitespace-only', async () => {
    // Mirror promote.test.ts pattern: bypass repo create() trim/validation
    // by inserting raw whitespace directly via db.
    t.db.insert(notes).values({ content: '   ' }).run();

    await expect(
      translateNote(1, { ...baseDeps(), callLlm: makeStubCallLlm('x') }),
    ).rejects.toMatchObject({ code: 'note_empty' satisfies TranslateNoteErrorCode });
  });

  it('throws already_target_language when note.language matches deps.language', async () => {
    const note = notesRepo.create({ content: 'hello', subtype: 'memo', language: 'en' });

    await expect(
      translateNote(note.id, { ...baseDeps(), callLlm: makeStubCallLlm('x') }),
    ).rejects.toMatchObject({
      code: 'already_target_language' satisfies TranslateNoteErrorCode,
    });
  });

  it('throws note_archived before calling LLM when note is archived', async () => {
    const note = notesRepo.create({ content: '你好', subtype: 'memo', language: 'zh' });
    notesRepo.update(note.id, { archived: true });
    const callLlm = makeStubCallLlm('Hello');

    await expect(translateNote(note.id, { ...baseDeps(), callLlm })).rejects.toMatchObject({
      code: 'note_archived' satisfies TranslateNoteErrorCode,
    });
    expect(callLlm).not.toHaveBeenCalled();
  });

  it('translates note and writes notes.content_translated on happy path', async () => {
    const note = notesRepo.create({ content: '你好世界', subtype: 'memo', language: 'zh' });

    const result = await translateNote(note.id, {
      ...baseDeps(),
      callLlm: makeStubCallLlm('Hello world'),
    });

    expect(result.contentTranslated).toBe('Hello world');
    const row = t.db.select().from(notes).where(eq(notes.id, note.id)).get();
    expect(row?.contentTranslated).toBe('Hello world');
  });

  it('throws translate_failed when LLM omits the requested note id', async () => {
    const note = notesRepo.create({ content: '你好', subtype: 'memo', language: 'zh' });

    await expect(
      translateNote(note.id, {
        ...baseDeps(),
        callLlm: vi.fn(async () => ({
          translations: [{ id: 'hallucinated', translated: 'Wrong row' }],
        })) as unknown as CallLlmFn,
      }),
    ).rejects.toMatchObject({ code: 'translate_failed' satisfies TranslateNoteErrorCode });
    const row = t.db.select().from(notes).where(eq(notes.id, note.id)).get();
    expect(row?.contentTranslated).toBeNull();
  });

  it('proceeds when note.language is null (auto-detect)', async () => {
    const note = notesRepo.create({ content: 'mixed content', subtype: 'note' });

    const result = await translateNote(note.id, {
      ...baseDeps(),
      language: 'zh' as const,
      callLlm: makeStubCallLlm('混合内容'),
    });

    expect(result.contentTranslated).toBe('混合内容');
  });

  it('throws translate_failed when LLM call rejects', async () => {
    const note = notesRepo.create({ content: '你好', subtype: 'memo', language: 'zh' });

    await expect(
      translateNote(note.id, {
        ...baseDeps(),
        callLlm: makeRejectingCallLlm(new Error('upstream timeout')),
      }),
    ).rejects.toMatchObject({ code: 'translate_failed' satisfies TranslateNoteErrorCode });
  });

  it('throws translate_failed when LLM returns empty translations array', async () => {
    const note = notesRepo.create({ content: '你好', subtype: 'memo', language: 'zh' });

    await expect(
      translateNote(note.id, {
        ...baseDeps(),
        callLlm: vi.fn(async () => ({ translations: [] })) as unknown as CallLlmFn,
      }),
    ).rejects.toMatchObject({ code: 'translate_failed' satisfies TranslateNoteErrorCode });
  });

  it('throws translate_failed when LLM returns whitespace-only translation', async () => {
    const note = notesRepo.create({ content: '你好', subtype: 'memo', language: 'zh' });

    await expect(
      translateNote(note.id, {
        ...baseDeps(),
        callLlm: makeStubCallLlm('   '),
      }),
    ).rejects.toMatchObject({ code: 'translate_failed' satisfies TranslateNoteErrorCode });
  });

  it('overwrites existing contentTranslated on re-trigger', async () => {
    const note = notesRepo.create({ content: '你好', subtype: 'memo', language: 'zh' });

    await translateNote(note.id, { ...baseDeps(), callLlm: makeStubCallLlm('first') });
    const second = await translateNote(note.id, {
      ...baseDeps(),
      callLlm: makeStubCallLlm('second'),
    });

    expect(second.contentTranslated).toBe('second');
    const row = t.db.select().from(notes).where(eq(notes.id, note.id)).get();
    expect(row?.contentTranslated).toBe('second');
  });

  it('throws note_changed and does not write stale translation when content changes mid-call', async () => {
    const note = notesRepo.create({ content: '你好', subtype: 'memo', language: 'zh' });
    const callLlm = vi.fn(async () => {
      notesRepo.update(note.id, { content: '内容已修改' });
      return { translations: [{ id: 'note', translated: 'Hello' }] };
    }) as unknown as CallLlmFn;

    await expect(translateNote(note.id, { ...baseDeps(), callLlm })).rejects.toMatchObject({
      code: 'note_changed' satisfies TranslateNoteErrorCode,
    });
    const row = t.db.select().from(notes).where(eq(notes.id, note.id)).get();
    expect(row?.content).toBe('内容已修改');
    expect(row?.contentTranslated).toBeNull();
  });
});
