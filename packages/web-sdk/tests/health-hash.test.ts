import { describe, expect, it } from 'vitest';
import { dualProcessConfigHash, HASH_FINGERPRINT_KEYS } from '../src/health-hash.js';

describe('HASH_FINGERPRINT_KEYS', () => {
  it('currently contains exactly GOLDPAN_LANGUAGE', () => {
    // Pin the key list — adding to this set has security implications
    // (anything in here is publicly observable via /health). Any change
    // should be a deliberate decision; this test will force a code review.
    expect([...HASH_FINGERPRINT_KEYS]).toEqual(['GOLDPAN_LANGUAGE']);
  });

  it('does NOT include GOLDPAN_AUTH_PASSWORD — public hash must not fingerprint a user password', () => {
    // Regression guard: AUTH_PASSWORD is now no longer in DUAL_PROCESS_RESTART_KEYS
    // at all (web syncs via /auth/status probe), but the security criterion
    // for HASH_FINGERPRINT_KEYS is still binding for any future password-like
    // key. Keep this guard so a thoughtless re-add to the fingerprint list
    // is caught before it ships. See health-hash.ts JSDoc.
    expect([...HASH_FINGERPRINT_KEYS]).not.toContain('GOLDPAN_AUTH_PASSWORD');
  });
});

describe('dualProcessConfigHash', () => {
  it('produces a stable 16-char hex fingerprint', () => {
    const env: NodeJS.ProcessEnv = { GOLDPAN_LANGUAGE: 'en' };
    const hash = dualProcessConfigHash(env);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(dualProcessConfigHash(env)).toBe(hash);
  });

  it('changes when GOLDPAN_LANGUAGE changes', () => {
    const en = dualProcessConfigHash({ GOLDPAN_LANGUAGE: 'en' });
    const zh = dualProcessConfigHash({ GOLDPAN_LANGUAGE: 'zh' });
    expect(en).not.toBe(zh);
  });

  it('is STABLE when GOLDPAN_AUTH_PASSWORD changes (password excluded from fingerprint)', () => {
    // Security regression guard — see HASH_FINGERPRINT_KEYS JSDoc. If a
    // future change re-introduces password into the public hash, this test
    // catches it before it ships.
    const before = dualProcessConfigHash({
      GOLDPAN_AUTH_PASSWORD: 'pw1',
      GOLDPAN_LANGUAGE: 'en',
    });
    const after = dualProcessConfigHash({
      GOLDPAN_AUTH_PASSWORD: 'pw2',
      GOLDPAN_LANGUAGE: 'en',
    });
    expect(after).toBe(before);
  });

  it('treats unset and empty string identically (both contribute "")', () => {
    const a = dualProcessConfigHash({});
    const b = dualProcessConfigHash({ GOLDPAN_LANGUAGE: '' });
    expect(a).toBe(b);
  });

  it('defaults to process.env when no argument is given', () => {
    // Smoke check — the default-argument path must run without throwing.
    const hash = dualProcessConfigHash();
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
