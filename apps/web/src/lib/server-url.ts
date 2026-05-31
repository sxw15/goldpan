/**
 * Resolved URL of the Goldpan server process, computed once at web boot from
 * `GOLDPAN_SERVER_URL` env (defaults to localhost:3001). Imported by every
 * web-side code path that fetches the server directly — middleware, RSC API
 * helpers, runtime-info probes — so the literal `process.env... || 'http://...'`
 * pattern doesn't have to be repeated (and kept in sync) across files.
 *
 * Edge + Node compatible: this module reads only `process.env` and exports a
 * plain string, so it's safe to import from middleware (Edge) and RSC (Node)
 * alike. No `server-only` import, no side effects.
 *
 * NOTE: like every other `process.env` read in the web process, this value is
 * captured at module evaluation time and does NOT live-update if the host
 * env mutates after boot. Restart web to pick up changes.
 */
export const SERVER_URL = process.env.GOLDPAN_SERVER_URL || 'http://localhost:3001';
