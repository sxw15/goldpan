import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteNotesRepository } from '../../src/db/repositories/notes.repository';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('SqliteNotesRepository skeleton', () => {
  let t: TestDB;

  beforeEach(() => {
    t = createTestDB();
  });
  afterEach(() => t.cleanup());

  it('instantiates and exposes all interface methods', () => {
    const repo = new SqliteNotesRepository(t.db);
    expect(repo).toBeDefined();
    expect(typeof repo.create).toBe('function');
    expect(typeof repo.get).toBe('function');
    expect(typeof repo.list).toBe('function');
    expect(typeof repo.update).toBe('function');
    expect(typeof repo.delete).toBe('function');
    expect(typeof repo.searchByContent).toBe('function');
  });

  it('get returns null for non-existent note', () => {
    const repo = new SqliteNotesRepository(t.db);
    expect(repo.get(99999)).toBeNull();
  });
});
