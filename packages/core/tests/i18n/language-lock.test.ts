import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteMetadataRepository } from '../../src/db/repositories/metadata.js';
import type { MetadataRepository } from '../../src/db/repositories/types.js';
import { resolveLanguageLock } from '../../src/i18n/language-lock.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

function createInMemoryMetadataRepo(): MetadataRepository {
  const store = new Map<string, string>();
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('resolveLanguageLock', () => {
  let repo: MetadataRepository;

  beforeEach(() => {
    repo = createInMemoryMetadataRepo();
  });

  it('stores and returns language on first call (empty DB)', () => {
    const result = resolveLanguageLock(repo, 'zh');
    expect(result).toBe('zh');
    expect(repo.get('db.language')).toBe('zh');
  });

  it('returns stored language when requested matches', () => {
    repo.set('db.language', 'en');
    const result = resolveLanguageLock(repo, 'en');
    expect(result).toBe('en');
  });

  it('throws when requested language differs from stored', () => {
    repo.set('db.language', 'en');
    expect(() => resolveLanguageLock(repo, 'zh')).toThrow(
      /Database language is locked to 'en'.*Cannot switch to 'zh'/,
    );
  });

  it('persists language so subsequent calls see it', () => {
    resolveLanguageLock(repo, 'zh');
    const result = resolveLanguageLock(repo, 'zh');
    expect(result).toBe('zh');
  });

  it('defaults pre-i18n DB with existing data to en', () => {
    const result = resolveLanguageLock(repo, 'zh', { hasExistingData: true });
    expect(result).toBe('en');
    expect(repo.get('db.language')).toBe('en');
  });

  it('warns when pre-i18n DB forces en over configured zh', () => {
    const warnings: string[] = [];
    resolveLanguageLock(repo, 'zh', {
      hasExistingData: true,
      warn: (msg) => warnings.push(msg),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Pre-i18n database detected/);
    expect(warnings[0]).toMatch(/locked to 'en'/);
  });

  it('allows requested language when pre-i18n DB has no existing data', () => {
    const result = resolveLanguageLock(repo, 'zh', { hasExistingData: false });
    expect(result).toBe('zh');
  });

  it('allows en even with pre-i18n DB with existing data', () => {
    const result = resolveLanguageLock(repo, 'en', { hasExistingData: true });
    expect(result).toBe('en');
  });

  it('works with real SqliteMetadataRepository', () => {
    const t: TestDB = createTestDB();
    try {
      const sqliteRepo = new SqliteMetadataRepository(t.db);

      const result = resolveLanguageLock(sqliteRepo, 'en');
      expect(result).toBe('en');
      expect(sqliteRepo.get('db.language')).toBe('en');

      // Same language again
      expect(resolveLanguageLock(sqliteRepo, 'en')).toBe('en');

      // Different language throws
      expect(() => resolveLanguageLock(sqliteRepo, 'zh')).toThrow(/locked to 'en'/);
    } finally {
      t.cleanup();
    }
  });
});
