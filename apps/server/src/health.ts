import { dualProcessConfigHash } from '@goldpan/web-sdk/health-hash';

export { dualProcessConfigHash };

/**
 * Locally-mirrored shape of an IM runtime channel descriptor.
 *
 * `apps/server` keeps its `/health` response contract self-contained — we don't import
 * `ChannelDescriptor` from `@goldpan/im-runtime` here even though `imRuntime.describeChannels()`
 * returns structurally-compatible objects. Two reasons:
 *
 * 1. The `/health` response is part of the server's external API surface; tying its types
 *    to an internal IM package would couple ops/monitoring tooling to that package's shape.
 * 2. A future "no IM" deployment of `apps/server` (e.g. a query-only reader replica) would
 *    otherwise have to install `@goldpan/im-runtime` solely for type resolution.
 *
 * The runtime continues to own channel state — we accept its descriptors verbatim via
 * structural typing at the call site (`runtimeChannels: imRuntime?.describeChannels() ?? []`
 * in main.ts). Drift behaviour:
 *
 * - If `ChannelDescriptor` adds a *required* field, or changes the `state` union to a value
 *   not listed below, TypeScript fails compilation **at the call site** (main.ts) — forcing
 *   a deliberate update to the wire shape.
 * - If `ChannelDescriptor` adds an *optional* field, TS does NOT catch it; the new field is
 *   silently dropped from `/health` responses. That is intentional for non-API state, but if
 *   ops/monitoring need a new field to surface, a maintainer must add it here as well.
 *
 * The contract test `health.test.ts -> ChannelDescriptor stays assignable to HealthChannelView`
 * pins the required-field/state-union direction; optional-field drift is left to PR review.
 */
export interface HealthChannelView {
  channelId: string;
  state: 'starting' | 'running' | 'shutting_down' | 'stopped' | 'error';
  account?: { id: string; displayName?: string };
  inFlightCount: number;
  lastErrorAt?: Date;
  lastErrorMessage?: string;
}

export interface HealthResponseBody {
  type?: 'error';
  code?: 'worker_not_running';
  message?: string;
  status: 'ok' | 'degraded';
  worker: { running: boolean };
  channels: HealthChannelView[];
  /**
   * Restart-required env keys committed since this server process booted —
   * union of every patch's `STATIC_RESTART_REQUIRED_KEYS` intersection,
   * accumulated by main.ts in a process-lifetime Set. External monitors
   * (and the web UI's settings polling) can use this to remind the user
   * they've saved boot-only keys without restarting yet. Sorted for stable
   * diff in monitoring tooling.
   */
  pendingRestartKeys: string[];
  /**
   * SHA-256 fingerprint (truncated to 16 hex chars) of the live values for
   * `HASH_FINGERPRINT_KEYS` (currently just `GOLDPAN_LANGUAGE`). External
   * monitors compare this between server's `/health` and web's
   * `/api/healthz` to detect "user restarted one process but forgot the
   * other" for keys that have no immediate failure mode if mismatched.
   *
   * `GOLDPAN_AUTH_PASSWORD` is intentionally NOT in the fingerprint. The
   * security reason (truncated hash on an unauthenticated endpoint would
   * be dictionary-attack-feasible) is still binding, but it's also no
   * longer in `DUAL_PROCESS_RESTART_KEYS` — web stopped maintaining its
   * own opinion of "auth required?" and now queries server's
   * `/auth/status` per request (see `apps/web/src/lib/auth-probe.ts`), so
   * there's no dual-process divergence to detect either. Server still
   * needs a restart for its own boot-snapshot to honour a new password
   * (per `STATIC_RESTART_REQUIRED_KEYS`), but web no longer does.
   *
   * The canonical implementation lives in `@goldpan/web-sdk/health-hash`
   * so server and web compute byte-identical fingerprints — see that
   * file's JSDoc for the full security rationale.
   *
   * Not a security primitive, just a fingerprint.
   */
  dualProcessConfigHash: string;
}

/**
 * Build a /health response from runtime-reported channel descriptors.
 *
 * `runtimeChannels` is the single source of truth for IM channel state — it already
 * reflects per-channel `error` / `stopped` / `running` and `lastErrorMessage`. Callers
 * MUST pass `imRuntime.describeChannels()` directly (or `[]` when no runtime exists)
 * and MUST NOT maintain a parallel "startup failure" list — composing channel state
 * outside the runtime is an architecture smell that drifts as new channels are added
 * (see runtime.ts startChannel comment).
 *
 * `pendingRestartKeys` is the process-lifetime accumulator from main.ts — every
 * settings commit feeds in via `onPendingRestart`. Caller passes the live Set
 * directly; we sort + dedupe inside this function for a deterministic wire
 * payload independent of insertion order.
 *
 * `dualProcessConfigHash` is computed at call time from the current
 * `process.env`. Caller decides whether to compute it lazily (skip for
 * worker-down branch where the response is already an error) or eagerly
 * — both are valid; we accept the value as a parameter so health.ts stays
 * pure.
 */
export function buildHealthResponse(opts: {
  workerRunning: boolean;
  runtimeChannels: HealthChannelView[];
  pendingRestartKeys: ReadonlySet<string>;
  dualProcessConfigHash: string;
}): { statusCode: number; body: HealthResponseBody } {
  const channels = opts.runtimeChannels;
  const allChannelsHealthy = channels.length === 0 || channels.every((c) => c.state === 'running');
  const pendingRestartKeys = [...opts.pendingRestartKeys].sort();

  if (!opts.workerRunning) {
    return {
      statusCode: 503,
      body: {
        type: 'error',
        code: 'worker_not_running',
        message: 'Worker is not running',
        status: 'degraded',
        worker: { running: false },
        channels,
        pendingRestartKeys,
        dualProcessConfigHash: opts.dualProcessConfigHash,
      },
    };
  }

  if (!allChannelsHealthy) {
    return {
      statusCode: 200,
      body: {
        status: 'degraded',
        worker: { running: true },
        channels,
        pendingRestartKeys,
        dualProcessConfigHash: opts.dualProcessConfigHash,
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      status: 'ok',
      worker: { running: true },
      channels,
      pendingRestartKeys,
      dualProcessConfigHash: opts.dualProcessConfigHash,
    },
  };
}
