import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRuntimeConfigOverrideRepository } from '../../../src/db/repositories/runtime-config.js';
import { createTestDB, type TestDB } from '../../helpers/test-db.js';

describe('SqliteRuntimeConfigOverrideRepository', () => {
  let t: TestDB;
  let repo: SqliteRuntimeConfigOverrideRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteRuntimeConfigOverrideRepository(t.db);
  });

  afterEach(() => {
    t.cleanup();
  });

  it('starts empty', () => {
    expect(repo.list().size).toBe(0);
  });

  it('upsert + list round-trip', () => {
    repo.upsert('OPENAI_API_KEY', 'sk-abc');
    repo.upsert('GOLDPAN_LLM_CLASSIFIER', 'openai:gpt-4o');
    const all = repo.list();
    expect(all.get('OPENAI_API_KEY')).toBe('sk-abc');
    expect(all.get('GOLDPAN_LLM_CLASSIFIER')).toBe('openai:gpt-4o');
  });

  it('upsert overwrites existing value', () => {
    repo.upsert('K', 'v1');
    repo.upsert('K', 'v2');
    expect(repo.list().get('K')).toBe('v2');
  });

  it('remove deletes', () => {
    repo.upsert('K', 'v');
    repo.remove('K');
    expect(repo.list().has('K')).toBe(false);
  });

  it('remove is idempotent on absent key', () => {
    expect(() => repo.remove('NOPE')).not.toThrow();
  });

  it('applyPatch upsert + null delete in one txn', () => {
    repo.upsert('A', 'a');
    repo.upsert('B', 'b');
    repo.applyPatch(
      new Map<string, string | null>([
        ['A', 'a-new'],
        ['B', null],
        ['C', 'c'],
      ]),
    );
    const all = repo.list();
    expect(all.get('A')).toBe('a-new');
    expect(all.has('B')).toBe(false);
    expect(all.get('C')).toBe('c');
  });
});
