// apps/server/src/routes/server/restart.ts
import type http from 'node:http';
import { respond } from '../types.js';

/**
 * Options for the restart handler factory. The factory does NOT verify auth —
 * both call sites (main.ts in normal mode, wizard-server.ts) gate this route
 * upstream (normal mode via `authRequired()`, wizard mode via localhost-only
 * binding).
 */
export interface RestartHandlerOptions {
  logger: { info: (msg: string) => void };
  onRestart?: () => void | Promise<void>;
}

/**
 * Build a `/server/restart` handler. The handler:
 * 1. Drains any incoming body (defensive — POST /server/restart shouldn't carry one).
 * 2. Replies 200 with an estimated restart time so the UI can poll `/health`.
 * 3. After 200 ms (enough for the response to flush):
 *    - if `onRestart` is provided, invoke it and return — that callback owns
 *      process termination (e.g. main.ts wires `shutdown`, which drains
 *      in-flight requests then calls `process.exit(0)` itself).
 *    - otherwise call `process.exit(0)` directly.
 *    The wrapping supervisor (docker / start:supervised / pm2 / systemd) is
 *    responsible for relaunching. If no supervisor wraps, the user sees the
 *    process exit and must restart manually — F8 UX handles that case via
 *    the `runtime-info` supervisor hint.
 */
export function createRestartHandler(opts: RestartHandlerOptions) {
  return function handleRestart(req: http.IncomingMessage, res: http.ServerResponse): void {
    req.resume();
    respond(res, 200, { status: 'restarting', estimatedSeconds: 5 });
    setTimeout(() => {
      opts.logger.info('Server restart triggered, exiting with code 0');
      if (opts.onRestart) {
        void opts.onRestart();
        return;
      }
      process.exit(0);
    }, 200);
  };
}
