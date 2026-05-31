#!/usr/bin/env node
/**
 * Supervisor that respawns `pnpm <command>` whenever it exits 0 — the contract
 * the wizard's `/server/restart` relies on (handler exits 0; this script
 * restarts back into normal mode with the freshly written `.env`).
 *
 * Used by:
 *   - `pnpm start:supervised` → wraps `pnpm start` (production, built code)
 *   - `pnpm dev` → wraps `pnpm dev:run` (dev, tsx watch + next dev under
 *     concurrently). This is what makes the wizard's one-click restart work
 *     for `pnpm dev` users — concurrently's `--success first` makes its exit
 *     code track the server's, so when the wizard triggers `process.exit(0)`,
 *     concurrently exits 0 too and we respawn.
 *
 * Inner command comes from argv[2]; defaults to `start` for backwards-compat
 * with the original `start:supervised` invocation.
 *
 * Behaviour worth knowing:
 *
 * 1. **Clean-exit-only respawn**: only exit code 0 triggers respawn. Crashes
 *    (non-zero) go through the failure brake (3 in a row → bail). Signals
 *    (Ctrl+C / SIGTERM) trigger immediate bail via the `shouldShutdown`
 *    flag — without this, dev users' Ctrl+C would loop through retries.
 *
 * 2. `GOLDPAN_FORCE_WIZARD` is stripped from the child env. Otherwise a
 *    one-shot `GOLDPAN_FORCE_WIZARD=true pnpm onboard` would loop forever
 *    (wizard exits 0 → respawn → still has env → wizard again).
 *    `GOLDPAN_FORCE_WIZARD_ALL_RESTARTS=true` opts back in for pathological
 *    cases like "I want every restart to re-prompt".
 *
 * 3. `SUPERVISED_BY_SCRIPT=true` is exported into the child so the server's
 *    runtime-info detection advertises `supervisor: 'supervised'` to the
 *    wizard UI (drives the auto-restart polling vs. manual-restart UX).
 */
import { spawn } from 'node:child_process';

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_BACKOFF_MS = 2000;

const innerCommand = process.argv[2] ?? 'start';

const preserveForceWizard = process.env.GOLDPAN_FORCE_WIZARD_ALL_RESTARTS === 'true';
const childEnv = { ...process.env, SUPERVISED_BY_SCRIPT: 'true' };
if (!preserveForceWizard) delete childEnv.GOLDPAN_FORCE_WIZARD;

let shouldShutdown = false;
let activeChild = null;

function onSignal(sig) {
  shouldShutdown = true;
  if (activeChild && !activeChild.killed) {
    activeChild.kill(sig);
  }
}

// Listen on the parent so Ctrl+C (SIGINT) and orchestrator stop signals
// (SIGTERM) flag a clean shutdown intent BEFORE forwarding to the child.
// The child's exit code on a signal is non-zero, but `shouldShutdown` makes
// the loop bail instead of treating it as a crash to retry.
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

let consecutiveFailures = 0;

function spawnChild() {
  return new Promise((resolve) => {
    activeChild = spawn('pnpm', [innerCommand], { stdio: 'inherit', env: childEnv });
    activeChild.on('exit', (code, signal) => {
      // signal-driven exit (e.g., the parent forwarded SIGINT) is also a
      // shutdown intent — set the flag in case the SIGINT handler didn't
      // run (rare, e.g. SIGKILL from outside).
      if (signal) shouldShutdown = true;
      activeChild = null;
      resolve(code ?? 1);
    });
  });
}

while (true) {
  const exitCode = await spawnChild();
  if (shouldShutdown) {
    process.exit(exitCode);
  }
  if (exitCode === 0) {
    console.log(`[supervised-start] '${innerCommand}' exited cleanly, restarting...`);
    consecutiveFailures = 0;
    continue;
  }
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    console.error(
      `[supervised-start] '${innerCommand}' failed ${MAX_CONSECUTIVE_FAILURES} times in a row, bailing`,
    );
    process.exit(exitCode);
  }
  console.warn(
    `[supervised-start] '${innerCommand}' exited with ${exitCode}, retrying in ${RETRY_BACKOFF_MS}ms...`,
  );
  await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
}
