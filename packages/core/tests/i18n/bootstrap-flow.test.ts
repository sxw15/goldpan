import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteMetadataRepository } from '../../src/db/repositories/metadata.js';
import { getLanguage, initI18n, resetI18n, resolveLanguageLock } from '../../src/i18n/index.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

describe('i18n bootstrap flow', () => {
  beforeEach(() => {
    resetI18n();
  });

  it('resolveLanguageLock → initI18n → getLanguage returns correct locale (zh)', () => {
    const testDb: TestDB = createTestDB();
    try {
      const metadataRepo = new SqliteMetadataRepository(testDb.db);
      const lang = resolveLanguageLock(metadataRepo, 'zh');
      initI18n(lang);
      expect(getLanguage()).toBe('zh');
    } finally {
      testDb.cleanup();
    }
  });

  it('bootstrap with en works end-to-end', () => {
    const testDb: TestDB = createTestDB();
    try {
      const metadataRepo = new SqliteMetadataRepository(testDb.db);
      const lang = resolveLanguageLock(metadataRepo, 'en');
      initI18n(lang);
      expect(getLanguage()).toBe('en');
    } finally {
      testDb.cleanup();
    }
  });
});
