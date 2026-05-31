// apps/server/src/routes/onboarding/validate.ts
import type http from 'node:http';
import { validateStagedConfig } from '@goldpan/core/onboarding';
import { parseJsonBody, respond, respondError } from '../types.js';
import { readJsonBody } from './_body.js';

/**
 * Thin wrapper around `@goldpan/core/onboarding.validateStagedConfig`.
 *
 * Body shape: `Record<string, string>` of already-serialized env keys (the
 * frontend runs `stateToEnvKeys` mirror-side and POSTs the result). Keeping
 * the route stateless — it does not consult the in-memory wizard state —
 * because the same validator is also useful for "what if I changed key X to
 * value Y" preflight checks where the wizard state isn't the source of truth.
 *
 * If the frontend wants to validate the current server-stored wizard state,
 * it reads `/state`, serializes locally, and POSTs that back. Two concerns
 * (state mutation vs validation) stay separate.
 */
export async function handleValidateRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    respondError(res, 405, 'method_not_allowed', 'Use POST');
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const parsed = parseJsonBody<Record<string, string>>(res, body);
  if (parsed === null) return;
  const result = validateStagedConfig(parsed);
  respond(res, 200, result);
}
