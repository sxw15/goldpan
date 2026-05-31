import type { MetadataRepository } from '../db/repositories/types';
import { DB_LANGUAGE_KEY } from '../i18n/language-lock';

export interface DigestInitialPreset {
  modules: string[]; // slot names: 'stats' | 'tracking_findings' | 'captures' | 'thoughts' | 'new_entities' | 'ai_summary'
  maxItems: number;
}

export interface TrackingInitialRule {
  name: string;
  description?: string;
  searchQueries: string[];
  intervalMinutes: number;
  toolProvider?: string;
}

export interface ApplyMetadataInput {
  language?: 'en' | 'zh';
  /**
   * When true, the database already contains processed data — language
   * seeding is skipped so the existing-data guard in normal-mode boot retains
   * authority over the language lock (otherwise the wizard could overwrite
   * a lock established by an earlier startup with implicit English).
   */
  hasExistingData?: boolean;
  digestPreset?: DigestInitialPreset;
  trackingRules?: TrackingInitialRule[];
}

/**
 * Write wizard-driven metadata seeds.
 *
 * - **language** writes to `DB_LANGUAGE_KEY` (`db.language`) — the same key
 *   `resolveLanguageLock` reads on every normal-mode boot. Idempotent: never
 *   overwrite once set (i18n lock; spec §6.1). Earlier drafts wrote a bare
 *   `'language'` key that no consumer read; switching to `db.language` makes
 *   the wizard's intent immediately visible to the next normal-mode boot
 *   (otherwise the lock would only "take" after first normal-mode startup
 *   wrote `db.language` itself).
 * - **digestPreset / trackingRules** are one-shot seeds the plugin postInit
 *   consumes (delete after read). Overwriting before consumption is allowed
 *   — re-running wizard means the user wants the new value.
 */
export function applyMetadata(repo: MetadataRepository, input: ApplyMetadataInput): void {
  if (input.language && !input.hasExistingData && repo.get(DB_LANGUAGE_KEY) === undefined) {
    repo.set(DB_LANGUAGE_KEY, input.language);
  }
  if (input.digestPreset) {
    repo.set('digest_initial_preset', JSON.stringify(input.digestPreset));
  }
  if (input.trackingRules && input.trackingRules.length > 0) {
    repo.set('tracking_initial_rules', JSON.stringify(input.trackingRules));
  }
}
