import { describe, expect, test } from 'vitest';
import { SqliteMetadataRepository } from '../../src/db/repositories/metadata';
import { applyMetadata } from '../../src/onboarding/apply-metadata';
import { createTestDB } from '../helpers/test-db';

describe('applyMetadata', () => {
  test('writes db.language only when first time (i18n lock — same key normal-mode reads)', () => {
    const t = createTestDB();
    try {
      const repo = new SqliteMetadataRepository(t.db);
      applyMetadata(repo, { language: 'zh' });
      // Wizard writes the same key normal-mode's resolveLanguageLock reads —
      // bare 'language' key is intentionally NOT used (would be a dead write).
      expect(repo.get('db.language')).toBe('zh');
      expect(repo.get('language')).toBeUndefined();
      // re-apply different language: lock prevents overwrite
      applyMetadata(repo, { language: 'en' });
      expect(repo.get('db.language')).toBe('zh');
    } finally {
      t.cleanup();
    }
  });

  test('does not pre-lock language when existing data needs normal-mode migration guard', () => {
    const t = createTestDB();
    try {
      const repo = new SqliteMetadataRepository(t.db);
      applyMetadata(repo, { language: 'zh', hasExistingData: true });
      expect(repo.get('db.language')).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  test('writes digest_initial_preset JSON when digest enabled', () => {
    const t = createTestDB();
    try {
      const repo = new SqliteMetadataRepository(t.db);
      applyMetadata(repo, {
        digestPreset: { modules: ['captures', 'ai_summary'], maxItems: 5 },
      });
      expect(JSON.parse(repo.get('digest_initial_preset')!)).toEqual({
        modules: ['captures', 'ai_summary'],
        maxItems: 5,
      });
    } finally {
      t.cleanup();
    }
  });

  test('writes tracking_initial_rules JSON when rules provided', () => {
    const t = createTestDB();
    try {
      const repo = new SqliteMetadataRepository(t.db);
      applyMetadata(repo, {
        trackingRules: [{ name: 'AI 安全', searchQueries: ['AI safety'], intervalMinutes: 1440 }],
      });
      const stored = JSON.parse(repo.get('tracking_initial_rules')!);
      expect(stored).toHaveLength(1);
      expect(stored[0].name).toBe('AI 安全');
    } finally {
      t.cleanup();
    }
  });

  test('skips empty arrays/options gracefully', () => {
    const t = createTestDB();
    try {
      const repo = new SqliteMetadataRepository(t.db);
      applyMetadata(repo, {});
      expect(repo.get('db.language')).toBeUndefined();
      expect(repo.get('digest_initial_preset')).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });
});
