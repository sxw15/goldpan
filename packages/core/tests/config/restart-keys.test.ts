import { describe, expect, it } from 'vitest';
import { STATIC_RESTART_REQUIRED_KEYS } from '../../src/config/index';
import { MANAGED_ENV_KEYS } from '../../src/onboarding/env-file';

// Locks the hot-reload classification of the content-length settings. They are
// read per-task via `ctx.config` (pipeline) and via live ConfigStore snapshots
// (server entry gates), so a Settings change applies WITHOUT a restart — they
// must stay OUT of STATIC_RESTART_REQUIRED_KEYS. A regression that adds one (or
// drops it from MANAGED_ENV_KEYS) would silently break the "改后立即生效"
// contract that the settings UI promises (no restart badge on these fields).
describe('content-length settings: hot-reload classification', () => {
  const CONTENT_LENGTH_KEYS = [
    'GOLDPAN_MAX_CONTENT_LENGTH',
    'GOLDPAN_MIN_CONTENT_LENGTH',
    'GOLDPAN_MAX_TEXT_INPUT_LENGTH',
  ] as const;

  for (const key of CONTENT_LENGTH_KEYS) {
    it(`${key} is managed and hot (NOT restart-required)`, () => {
      expect(MANAGED_ENV_KEYS as readonly string[]).toContain(key);
      expect(STATIC_RESTART_REQUIRED_KEYS).not.toContain(key);
    });
  }
});
