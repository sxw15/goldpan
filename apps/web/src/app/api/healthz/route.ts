import { dualProcessConfigHash } from '@goldpan/web-sdk/health-hash';

/**
 * Web-side health probe.
 *
 * Mirrors the `dualProcessConfigHash` field from server's `/health` so an
 * external monitor can byte-compare the two endpoints and detect "user
 * restarted server but forgot to restart web" (or vice versa) for env keys
 * that have no immediate failure mode if mismatched.
 *
 * We intentionally do NOT mirror server's `pendingRestartKeys` here:
 * - That field reflects server-process state (which boot-only keys have
 *   been committed but not yet restarted in the worker process).
 * - The web Node process has no view into the server's lifetime accumulator,
 *   so the only way to surface it would be a server proxy fetch on every
 *   `/api/healthz` call — wrong abstraction for a low-cost probe.
 * - Spec only requires the hash for cross-process comparison.
 */
export function GET() {
  return Response.json({
    ok: true,
    dualProcessConfigHash: dualProcessConfigHash(),
  });
}
