// apps/server/src/lib/restart-cascade.ts
//
// `tsx watch` (used by `pnpm server:dev`) does NOT propagate child
// `process.exit(0)` — it stays alive waiting for file changes. That breaks
// the supervisor's clean-exit-driven respawn for the `pnpm dev` chain
// (supervisor → pnpm dev:run → concurrently → pnpm server:dev → tsx watch
// → us). Empirically, sending SIGTERM to tsx watch makes it exit cleanly
// with code 0, which lets the chain unwind and the supervisor see the
// expected clean exit. The whole dev:run respawns (server + web together)
// because dual-process env keys (e.g. GOLDPAN_AUTH_PASSWORD,
// GOLDPAN_LANGUAGE) are read at process boot in BOTH server and web —
// restarting just the server would leave web running with stale values.
//
// Production path (built code under `node` directly) doesn't have tsx
// watch in the chain — process.exit(0) propagates fine — so we only kill
// the parent when we detect dev mode via `npm_lifecycle_event === 'dev'`.

/**
 * If the current server process is running under `tsx watch` (dev mode),
 * send SIGTERM to its immediate parent so the dev-chain exit codes
 * propagate up to the supervisor. NOOP in production / unsupervised
 * setups, where the parent is something we shouldn't poke (node
 * directly, docker init, etc.).
 *
 * Call this just BEFORE `process.exit(0)` in any restart-driven shutdown
 * path (the wizard's /server/restart route, the normal-mode admin
 * /server/restart route).
 *
 * Errors (parent gone, no permission) are swallowed — the caller is
 * already exiting, so the worst case is the supervisor times out and
 * the user sees a manual-restart prompt instead of the auto-redirect.
 */
export function unstickTsxWatchParent(env: NodeJS.ProcessEnv = process.env): void {
  if (env.npm_lifecycle_event !== 'dev') return;
  try {
    process.kill(process.ppid, 'SIGTERM');
  } catch {
    // ppid no longer exists or no permission — fall through to exit.
  }
}
