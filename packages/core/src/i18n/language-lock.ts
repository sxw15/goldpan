import type { MetadataRepository } from '../db/repositories/types';
import type { Language } from './types';

/**
 * Metadata key holding the deployment's locked language. Single source of
 * truth — exported so the wizard's `applyMetadata` can write the same key
 * (avoids "wizard wrote 'language' but normal-mode reads 'db.language'"
 * dead-write divergence).
 */
export const DB_LANGUAGE_KEY = 'db.language';

/**
 * Ensures the database language is consistent across runs.
 *
 * On first run, persists the requested language into db_metadata.
 * On subsequent runs, verifies the requested language matches the stored one.
 * Throws if they differ — switching language on an existing DB is not supported.
 *
 * When `options.hasExistingData` is true (pre-i18n database detected), forces
 * English to avoid mixing languages in stored data.
 */
export function resolveLanguageLock(
  metadataRepo: MetadataRepository,
  requestedLanguage: Language,
  options?: { hasExistingData?: boolean; warn?: (msg: string) => void },
): Language {
  const stored = metadataRepo.get(DB_LANGUAGE_KEY) as Language | undefined;

  if (stored !== undefined && stored !== 'en' && stored !== 'zh') {
    throw new Error(`Invalid language '${stored}' in database metadata. Expected 'en' or 'zh'.`);
  }

  if (!stored) {
    // Pre-i18n database detection: if DB has existing data but no language
    // metadata, force English to avoid mixing languages in stored data.
    if (options?.hasExistingData && requestedLanguage !== 'en') {
      metadataRepo.set(DB_LANGUAGE_KEY, 'en');
      options.warn?.(
        `Pre-i18n database detected with existing data. ` +
          `Language locked to 'en'. To use '${requestedLanguage}', ` +
          `start with a fresh database.`,
      );
      return 'en';
    }
    metadataRepo.set(DB_LANGUAGE_KEY, requestedLanguage);
    return requestedLanguage;
  }

  if (stored === requestedLanguage) {
    return stored;
  }

  throw new Error(
    `Database language is locked to '${stored}'. Cannot switch to '${requestedLanguage}'. ` +
      `Create a new database to use a different language.`,
  );
}
