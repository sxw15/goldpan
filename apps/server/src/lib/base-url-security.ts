import { validateSsrfIfEnabled } from '@goldpan/core/utils';

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/**
 * Read the SSRF kill-switch from the staged env file the wizard is about to
 * commit, falling back to the live `process.env` value (for callers like
 * `test-provider` that run before commit). Defaults to `true` (strict).
 *
 * Wizard does NOT surface this knob in its UI by design — it's a
 * security-weakening operator escape hatch — so the wizard sees it only via
 * the `.env` the user drops in before launching, NOT via form fields.
 */
export function resolveSsrfValidationEnabled(stagedKeys?: Map<string, string>): boolean {
  const staged = stagedKeys?.get('GOLDPAN_SSRF_VALIDATION_ENABLED');
  const raw = staged ?? process.env.GOLDPAN_SSRF_VALIDATION_ENABLED;
  return raw !== 'false';
}

export async function validateProviderBaseUrl(
  providerId: string,
  base: string,
  ssrfValidationEnabled: boolean,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`${providerId} baseUrl is not a valid URL: ${base}`);
  }
  // Ollama is local-only inference (HTTP server bundled with the model
  // runtime). A remote baseUrl is never a legitimate config — either a
  // misconfiguration (pasted the wrong provider's URL) or a deliberate
  // redirect to an attacker-controlled endpoint. Loopback-only is a hardcoded
  // invariant: it stays unconditional even when the SSRF kill-switch is off,
  // since "Ollama only runs locally" is true regardless of the user's network.
  if (providerId === 'ollama') {
    if (!isLoopbackHostname(url.hostname)) {
      throw new Error('Ollama baseUrl must target localhost / loopback only');
    }
    return;
  }
  await validateSsrfIfEnabled(base, ssrfValidationEnabled);
}

const BASE_URL_PROVIDER: Record<string, string> = {
  OPENAI_BASE_URL: 'openai',
  DEEPSEEK_BASE_URL: 'deepseek',
  OLLAMA_BASE_URL: 'ollama',
};

export async function validateStagedBaseUrls(stagedKeys: Map<string, string>): Promise<void> {
  const ssrfValidationEnabled = resolveSsrfValidationEnabled(stagedKeys);
  for (const [key, providerId] of Object.entries(BASE_URL_PROVIDER)) {
    const value = stagedKeys.get(key);
    if (value) await validateProviderBaseUrl(providerId, value, ssrfValidationEnabled);
  }
}

/**
 * Distinguish transient DNS failures (resolver timeout / network error) from
 * policy violations (no record / private IP). The first should bubble up as a
 * 5xx so the user retries; the second is a legitimate `kind: 'errors'`. See
 * `packages/core/src/utils/ssrf.ts:160,183` for the exact thrown messages.
 *
 * Co-located here so the ConfigStore-backed `/settings/env` and the wizard
 * onboarding commit handler share a single SSRF-classification source. The
 * legacy `commit-env-patch.ts` callsite has been removed (PR1 Task 15).
 */
export function isTransientDnsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /DNS resolution (timed out|error)/.test(msg);
}
