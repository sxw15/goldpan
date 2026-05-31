import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteNotesRepository } from '../../src/db/repositories/notes.repository';
import { noteSources, notes, processingTasks, sources } from '../../src/db/schema';
import { promoteNoteToSource } from '../../src/notes/promote';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('promoteNoteToSource', () => {
  let t: TestDB;
  let notesRepo: SqliteNotesRepository;

  beforeEach(() => {
    t = createTestDB();
    notesRepo = new SqliteNotesRepository(t.db);
  });

  afterEach(() => t.cleanup());

  const deps = () => ({
    notesRepo,
    db: t.db,
    submitDeps: { db: t.db, maxTextInputLength: 10000, ssrfValidationEnabled: false },
  });

  const promotableContent = (label = 'promotable note content') =>
    `${label} ${'with enough context '.repeat(40)}`.trim();

  it('throws note_not_found when note missing', async () => {
    await expect(promoteNoteToSource(999, deps())).rejects.toMatchObject({
      code: 'note_not_found',
    });
  });

  it('throws note_archived when note.archived = true', async () => {
    const note = notesRepo.create({
      content: promotableContent('archived promote note'),
    });
    notesRepo.update(note.id, { archived: true });

    await expect(promoteNoteToSource(note.id, deps())).rejects.toMatchObject({
      code: 'note_archived',
    });
  });

  it('throws note_empty when content is whitespace-only', async () => {
    // Direct DB insert to bypass create() trim/validation if any
    t.db.insert(notes).values({ content: '   ' }).run();

    await expect(promoteNoteToSource(1, deps())).rejects.toMatchObject({ code: 'note_empty' });
  });

  it('throws note_too_short before creating a source/task', async () => {
    const note = notesRepo.create({ content: 'short note' });

    await expect(promoteNoteToSource(note.id, deps())).rejects.toMatchObject({
      code: 'note_too_short',
    });

    expect(t.db.select().from(sources).all()).toHaveLength(0);
    expect(t.db.select().from(processingTasks).all()).toHaveLength(0);
    expect(t.db.select().from(noteSources).all()).toHaveLength(0);
  });

  it('throws note_too_long before creating a source/task', async () => {
    const content = promotableContent('too long promote note');
    const note = notesRepo.create({ content });

    await expect(
      promoteNoteToSource(note.id, {
        notesRepo,
        db: t.db,
        submitDeps: {
          db: t.db,
          maxTextInputLength: content.length - 1,
          ssrfValidationEnabled: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'note_too_long' });

    expect(t.db.select().from(sources).all()).toHaveLength(0);
    expect(t.db.select().from(processingTasks).all()).toHaveLength(0);
    expect(t.db.select().from(noteSources).all()).toHaveLength(0);
  });

  it('happy path: returns { taskId, sourceId } + writes note_sources row', async () => {
    const content = promotableContent('sample content for promotion');
    const note = notesRepo.create({ content });

    const result = await promoteNoteToSource(note.id, deps());

    expect(result).toEqual({ taskId: expect.any(Number), sourceId: expect.any(Number) });

    const source = t.db.select().from(sources).where(eq(sources.id, result.sourceId)).get();
    expect(source).toMatchObject({
      id: result.sourceId,
      kind: 'user',
      rawContent: content,
      title: `${content.slice(0, 77)}...`,
      status: 'processing',
      origin: 'user',
    });

    const task = t.db
      .select()
      .from(processingTasks)
      .where(eq(processingTasks.id, result.taskId))
      .get();
    expect(task).toMatchObject({
      id: result.taskId,
      sourceId: result.sourceId,
      type: 'pipeline',
      status: 'pending',
      inputType: 'text',
    });

    // Verify note_sources row was inserted with derived_from relation
    const rows = t.db.select().from(noteSources).all();
    expect(rows).toContainEqual(
      expect.objectContaining({
        noteId: note.id,
        sourceId: result.sourceId,
        relation: 'derived_from',
      }),
    );
  });

  it('idempotent: second promote returns existing source/task without creating another run', async () => {
    const note = notesRepo.create({
      content: promotableContent('idempotent promote note'),
    });
    const first = await promoteNoteToSource(note.id, deps());
    const second = await promoteNoteToSource(note.id, deps());

    expect(second).toEqual(first);
    expect(t.db.select().from(sources).all()).toHaveLength(1);
    expect(t.db.select().from(processingTasks).all()).toHaveLength(1);
    expect(t.db.select().from(noteSources).all()).toHaveLength(1);
  });

  it('truncates long promoted source titles while keeping rawContent intact', async () => {
    const content = `${'word '.repeat(140)}tail`;
    const note = notesRepo.create({ content });

    const result = await promoteNoteToSource(note.id, deps());

    const source = t.db.select().from(sources).where(eq(sources.id, result.sourceId)).get();
    expect(source?.rawContent).toBe(content);
    expect(source?.title).toHaveLength(80);
    expect(source?.title?.endsWith('...')).toBe(true);
  });

  it('logs accepted submissions without letting log failures abort promotion', async () => {
    const content = promotableContent('log failure promote note');
    const note = notesRepo.create({ content });
    const submissionLog = {
      create: () => {
        throw new Error('log failed');
      },
    };

    await expect(
      promoteNoteToSource(note.id, {
        notesRepo,
        db: t.db,
        submitDeps: {
          db: t.db,
          maxTextInputLength: 10000,
          ssrfValidationEnabled: false,
          submissionLog: submissionLog as never,
        },
      }),
    ).resolves.toEqual({ taskId: expect.any(Number), sourceId: expect.any(Number) });
  });

  it('writes source/task/link atomically when source creation succeeds', async () => {
    const note = notesRepo.create({
      content: promotableContent('atomic promote note'),
    });
    const result = await promoteNoteToSource(note.id, deps());

    expect(t.db.select().from(sources).where(eq(sources.id, result.sourceId)).get()).toBeTruthy();
    expect(
      t.db.select().from(processingTasks).where(eq(processingTasks.id, result.taskId)).get(),
    ).toBeTruthy();
    expect(
      t.db.select().from(noteSources).where(eq(noteSources.sourceId, result.sourceId)).get(),
    ).toBeTruthy();
  });
});
