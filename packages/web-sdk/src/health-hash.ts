import { createHash } from 'node:crypto';

/**
 * Subset of `DUAL_PROCESS_RESTART_KEYS` that goes into the
 * `dualProcessConfigHash` exposed by `/health` (server) and `/api/healthz`
 * (web).
 *
 * Currently equal to the full DUAL_PROCESS list (`GOLDPAN_LANGUAGE` only)
 * — declared as a separate constant anyway because the two answer different
 * questions: DUAL_PROCESS asks "does the user need to restart both processes
 * after changing this?" and FINGERPRINT asks "is it safe to leak this key's
 * value through an unauthenticated drift hash?". Future keys may sit in
 * DUAL_PROCESS but not FINGERPRINT (e.g. a future secret that would fail
 * the safety criterion below).
 *
 * `GOLDPAN_AUTH_PASSWORD` was previously in DUAL_PROCESS but deliberately
 * excluded here for security; it has since been removed from DUAL_PROCESS
 * entirely (web queries server's `/auth/status` per request via
 * `apps/web/src/lib/auth-probe.ts`, so there's no longer a per-process
 * opinion to diverge). The security criterion is still binding for any
 * future password-like key:
 *
 * - `/health` is unauthenticated by design (ops monitors hit it without
 *   credentials), so any value derived from it is publicly observable.
 * - The hash is SHA-256 truncated to 16 hex chars (64 bits). With the
 *   self-hosted minimum password length of 8 chars, an offline dictionary
 *   attack against the truncated hash is computationally feasible.
 *
 * `GOLDPAN_LANGUAGE` is the actual case where fingerprinting helps: a user
 * sees server-translated text but the web UI still shows the old language
 * with no immediate symptom — exactly the silent-divergence case the hash
 * was designed to catch.
 *
 * If a future env key needs to be added to the fingerprint, it must satisfy
 * BOTH:
 * 1. Read identically by both server and web from `process.env` (no per-
 *    process transformation).
 * 2. No immediate failure mode if mismatched (otherwise the natural failure
 *    is a better signal than a hash diff).
 */
export const HASH_FINGERPRINT_KEYS = ['GOLDPAN_LANGUAGE'] as const;

/**
 * Compute the dual-process config hash from `process.env`. Used by both
 * `apps/server` (`/health`) and `apps/web` (`/api/healthz`) so the
 * fingerprints are byte-comparable across the two processes — a single
 * source of truth for the algorithm + key list.
 *
 * SHA-256 truncated to 16 hex chars (64-bit fingerprint). Not a security
 * primitive — see `HASH_FINGERPRINT_KEYS` JSDoc for why password is
 * intentionally excluded.
 *
 * **Scope: raw-env drift, not effective-config drift.** The hash compares
 * raw `process.env[key]` strings between server and web — it answers "do
 * the two processes' raw env values match?" and does NOT account for any
 * downstream transformation that either process might apply on top:
 *
 * - Server may run `resolveLanguageLock` (i18n/language-lock.ts) which can
 *   force the effective language to `'en'` on a pre-i18n DB even when
 *   `process.env.GOLDPAN_LANGUAGE='zh'`. In that case the raw-env hash
 *   matches across processes but the effective rendered language differs.
 * - Likewise web's `apps/web/src/i18n/request.ts` honors a
 *   `wizard-locale` cookie that bypasses env in wizard mode (wizard
 *   doesn't expose normal `/health`, so this case is not observable in
 *   practice but worth noting).
 *
 * The intended primary use case — "user committed a DB override on the
 * server but didn't update the web `.env`" — is covered correctly because
 * (a) the user-visible env on web stays the boot value, (b) the override
 * mutates the server's `process.env` post-merge, so raw env diverges and
 * the hash flips. Effective-config drift detection is out of scope here.
 */
export function dualProcessConfigHash(env: NodeJS.ProcessEnv = process.env): string {
  const h = createHash('sha256');
  for (const key of HASH_FINGERPRINT_KEYS) {
    const value = env[key] ?? '';
    h.update(`${key}=${value}\n`);
  }
  return h.digest('hex').slice(0, 16);
}
