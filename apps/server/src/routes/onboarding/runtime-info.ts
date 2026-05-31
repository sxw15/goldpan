// apps/server/src/routes/onboarding/runtime-info.ts
import type http from 'node:http';
import { respond } from '../types.js';

/**
 * Which supervisor wraps the current process.
 *
 * - `docker`: container entrypoint sets `SUPERVISED_BY_DOCKER=true`. Restart
 *   is one-click — `process.exit(0)` triggers Docker's restart policy.
 * - `supervised`: `scripts/supervised-start.mjs` sets `SUPERVISED_BY_SCRIPT=true`.
 *   This is the path taken by both `pnpm start:supervised` (production) AND
 *   the default `pnpm dev` (which now wraps `pnpm dev:run` with the same
 *   supervisor — see scripts/supervised-start.mjs). For `pnpm dev` the
 *   restart cascade also requires the server to SIGTERM its tsx watch
 *   parent on exit (see lib/restart-cascade.ts) because tsx watch absorbs
 *   `process.exit(0)`. One-click UX: the script respawns the child.
 * - `concurrently`: fallback for the rare case where the user invoked
 *   `pnpm dev:run` / `pnpm start` directly, bypassing the supervisor.
 *   Detected by `npm_lifecycle_event` ∈ {dev, start, dev:run} when the
 *   script flags above are absent. UX: instruct user to Ctrl+C and re-run.
 * - `unknown`: bare `node`, `pm2`, `systemd`, etc. UX: poll for 60 s; if not
 *   back, instruct manual restart.
 */
export type Supervisor = 'docker' | 'supervised' | 'concurrently' | 'unknown';

export function detectSupervisor(env: NodeJS.ProcessEnv = process.env): Supervisor {
  if (env.SUPERVISED_BY_DOCKER === 'true') return 'docker';
  if (env.SUPERVISED_BY_SCRIPT === 'true') return 'supervised';
  // `dev:run` is the supervisor's inner command (root pnpm dev now wraps
  // it with the supervisor — but if a user invokes pnpm dev:run directly,
  // we want the same fallback messaging as pnpm dev / start).
  if (
    env.npm_lifecycle_event === 'dev' ||
    env.npm_lifecycle_event === 'start' ||
    env.npm_lifecycle_event === 'dev:run'
  ) {
    return 'concurrently';
  }
  return 'unknown';
}

export function handleRuntimeInfoRoute(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Drain incoming body to avoid lingering data on keep-alive sockets.
  req.resume();
  respond(res, 200, { supervisor: detectSupervisor() });
}
