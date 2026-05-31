import { loadConfig } from '../config';
import { errorMessage } from '../errors';
import { missingKeyedProviders, modelIdsFromConfig, providerKeyEnv } from './provider-keys';

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: { path: string; message: string; code?: string }[] };

export interface ValidateStagedConfigOptions {
  knownLlmProviderIds?: ReadonlyArray<string>;
  touchedKeys?: ReadonlyArray<string>;
}

function isModelIdFormat(value: string): boolean {
  const colonIdx = value.indexOf(':');
  if (colonIdx <= 0 || colonIdx === value.length - 1) return false;
  const provider = value.slice(0, colonIdx);
  return /^[a-z][a-z0-9_-]*$/.test(provider);
}

/**
 * Run the full strict `loadConfig()` against staged keys (without mutating
 * `process.env`). This is the same path bootstrap will take in normal mode
 * after the wizard exits, so passing here means the user's choices will
 * actually start the server cleanly.
 *
 * Builds a merged env (`process.env ⊕ staged`) and passes it to `loadConfig`
 * via its `envOverride` parameter — no `process.env` mutation, safe to call
 * concurrently with other validators.
 *
 * Failure shape: `loadConfig()` either throws a `ZodError` (format issues
 * from `envSchema.parse`) or a plain `Error` (cross-field business rules
 * like threshold ordering, production-requires-password). We flatten both
 * into a single `{ path: '', message }` entry. Per-field zod paths aren't
 * surfaced yet — the wizard UI re-validates on the client per-field anyway,
 * and the server response just needs to gate `commit`.
 */
export function validateStagedConfig(
  staged: Record<string, string>,
  options: ValidateStagedConfigOptions = {},
): ValidationResult {
  // `staged` is already the full bootEnv ⊕ overrides ⊕ patch view (see
  // `validateStaged` step 2). Spreading `process.env` on top would re-introduce
  // values that the patch's `null` deletes were supposed to clear (process.env
  // still holds them via past commits), so a delete-of-override would falsely
  // pass validation. Trust the caller-built `staged` as the only source.
  const merged: NodeJS.ProcessEnv = { ...staged };

  try {
    const config = loadConfig(merged);
    const verifierModel = merged.GOLDPAN_LLM_VERIFIER;
    const touchedKeys = new Set(options.touchedKeys ?? []);
    if (
      touchedKeys.has('GOLDPAN_LLM_VERIFIER') &&
      typeof verifierModel === 'string' &&
      !isModelIdFormat(verifierModel)
    ) {
      return {
        ok: false,
        errors: [
          {
            path: 'GOLDPAN_LLM_VERIFIER',
            message: `GOLDPAN_LLM_VERIFIER must be providerId:modelId format (got "${verifierModel}")`,
          },
        ],
      };
    }
    const providerOptions = {
      customProviders: config.customLlmProviders,
      knownProviderIds: options.knownLlmProviderIds,
    };
    const missingProviders = missingKeyedProviders(
      modelIdsFromConfig(config),
      merged,
      providerOptions,
    );
    if (missingProviders.length > 0) {
      return {
        ok: false,
        errors: [
          {
            path: '',
            message: `Missing API key(s) for referenced provider(s): ${missingProviders
              .map((provider) => `${provider} (${providerKeyEnv(provider, providerOptions)})`)
              .join(', ')}`,
          },
        ],
      };
    }
    return { ok: true };
  } catch (e) {
    // Cross-field rules in loadConfig may throw with a `code` (e.g. the
    // content-length ordering rules) so the settings UI can localize by code.
    const code = (e as { code?: unknown }).code;
    return {
      ok: false,
      errors: [
        { path: '', message: errorMessage(e), ...(typeof code === 'string' ? { code } : {}) },
      ],
    };
  }
}
