import { type ZodRawShape, z } from 'zod';
import { extractDynamicAllowedEnvNames, isManagedEnvKey } from '../onboarding/env-file';
import { validateStagedConfig } from '../onboarding/validate';
import type { ConfigPatch } from './store-types';

/**
 * Drop null-valued entries (= delete-override markers) from a patch,
 * leaving only set-overrides as a plain string→string map. Used by callers
 * that need the "string entries only" view (SSRF base-url scan, dynamic
 * allowlist extraction, allKeys growth in commit) — null deletions don't
 * carry a value to inspect / extract / merge.
 */
export function stripNulls(patch: ConfigPatch): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of patch) if (v !== null) out.set(k, v);
  return out;
}

export interface ValidateStagedInput {
  patch: ConfigPatch;
  bootEnv: Readonly<NodeJS.ProcessEnv>;
  currentOverrides: ReadonlyMap<string, string>;
  pluginEnvKeys?: ReadonlyArray<string>;
  pluginEnvSchemas?: ReadonlyArray<ZodRawShape>;
  knownLlmProviderIds?: ReadonlyArray<string>;
}

export type ValidateStagedResult =
  | { ok: true; stagedRecord: Record<string, string> }
  | { ok: false; errors: { path: string; message: string; code?: string }[] };

/**
 * Single source of truth for "this patch is safe to persist". Used by both
 * ConfigStore.commit (normal mode) and commitWizardOverrides (wizard mode).
 *
 * Pipeline:
 *   1. Whitelist check — every patch key must be in MANAGED_ENV_KEYS ∪
 *      MANAGED_ENV_PATTERNS-matched ∪ pluginEnvKeys ∪ extractDynamicAllowedEnvNames(patch).
 *   2. Build stagedRecord = bootEnv ⊕ currentOverrides ⊕ patch (null deletes).
 *   3. Plugin envSchema validation (z.object default-strip, non-plugin keys pass through).
 *   4. Core lenient + cross-field validation (validateStagedConfig).
 *
 * SSRF check is intentionally NOT here — it depends on async DNS resolution
 * and lives at the route layer (settings + wizard both call validateStagedBaseUrls
 * before invoking the corresponding commit function). Reason: keeping core
 * SSRF-agnostic lets future programmatic callers (CLI tools / tests) skip the
 * resolver overhead. Both Task 14 (settings route) and Task 16 (wizard route)
 * MUST call SSRF before reaching the commit function — if you remove either
 * of those calls, you've introduced a regression.
 */
export function validateStaged(input: ValidateStagedInput): ValidateStagedResult {
  const { patch, bootEnv, currentOverrides, pluginEnvKeys = [], pluginEnvSchemas } = input;

  // 1. Whitelist
  const dynamicAllowList = extractDynamicAllowedEnvNames(stripNulls(patch));
  const rejected: string[] = [];
  for (const key of patch.keys()) {
    if (!isManagedEnvKey(key, pluginEnvKeys, dynamicAllowList)) rejected.push(key);
  }
  if (rejected.length > 0) {
    return {
      ok: false,
      errors: rejected.map((k) => ({
        path: k,
        message: `key not in managed override whitelist`,
      })),
    };
  }

  // 2. Staged record — model the post-commit override layer first, then merge
  //    on top of bootEnv. A `null` patch entry MUST only remove the OVERRIDE
  //    contribution (the bootEnv value should fall through), matching how
  //    `mergeEnv` builds the post-commit snapshot. Building bootEnv ⊕ overrides
  //    ⊕ patch directly and treating `null` as a `delete stagedRecord[k]`
  //    incorrectly removes the bootEnv value too — a delete-of-override would
  //    then look like "key absent" and fail validation even when bootEnv has
  //    a perfectly valid baseline value.
  const newOverrides = new Map<string, string>(currentOverrides);
  for (const [k, v] of patch) {
    if (v === null) newOverrides.delete(k);
    else newOverrides.set(k, v);
  }
  const stagedRecord: Record<string, string> = {};
  for (const [k, v] of Object.entries(bootEnv)) {
    if (typeof v === 'string') stagedRecord[k] = v;
  }
  for (const [k, v] of newOverrides) stagedRecord[k] = v;

  // 3. Plugin schemas
  if (pluginEnvSchemas && pluginEnvSchemas.length > 0) {
    const merged: Record<string, z.ZodTypeAny> = {};
    for (const shape of pluginEnvSchemas) Object.assign(merged, shape);
    const result = z.object(merged).safeParse(stagedRecord);
    if (!result.success) {
      return {
        ok: false,
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
    }
  }

  // 4. Core lenient + cross-field
  const validation = validateStagedConfig(stagedRecord, {
    knownLlmProviderIds: input.knownLlmProviderIds,
    touchedKeys: [...patch.keys()],
  });
  if (!validation.ok) return { ok: false, errors: validation.errors };

  return { ok: true, stagedRecord };
}
