import { validateSsrfIfEnabled } from '../../../utils/ssrf';
import { CollectorError } from '../../errors';

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/**
 * SSRF-safe fetch with manual redirect following (spec §9.3).
 * Validates each redirect hop against SSRF rules.
 * Returns the final Response and the URL after all redirects.
 * Does NOT throw on 4xx/5xx — caller decides how to handle HTTP errors.
 *
 * ### Known limitation (V1) — DNS rebinding TOCTOU
 *
 * `validateSsrf()` resolves DNS and checks the IP *before* `fetch()` opens a
 * connection.  Because `fetch()` performs its own DNS resolution, an attacker-
 * controlled hostname can return a public IP during validation and then
 * re-resolve to a private/loopback IP when the connection is actually made
 * (classic DNS rebinding).  Node 22's undici-based `fetch` does not expose
 * the remote IP of the connection, so we cannot post-validate it here.
 *
 * Residual risk is low for typical deployments (short DNS TTLs are needed for
 * the attack, and most internal services don't speak HTTP on expected ports),
 * but it is not zero.
 *
 * @see https://en.wikipedia.org/wiki/DNS_rebinding
 */
export interface SafeFetchOptions {
  /** Hop cap; defaults to 5. */
  maxRedirects?: number;
  /**
   * Mirror of `GoldpanConfig.ssrfValidationEnabled`. Required — see the same
   * field on `SubmitDeps` for why we do not silently default.
   */
  ssrfValidationEnabled: boolean;
}

export async function safeFetch(
  url: string,
  signal: AbortSignal | undefined,
  options: SafeFetchOptions,
): Promise<{ response: Response; finalUrl: string }> {
  const { maxRedirects = 5, ssrfValidationEnabled } = options;
  let current = url;
  const visited = new Set<string>();
  // i=0 is the initial request; i=1..maxRedirects are redirect hops.
  // So `<= maxRedirects` correctly allows up to `maxRedirects` hops.
  for (let i = 0; i <= maxRedirects; i++) {
    if (visited.has(current)) {
      throw new CollectorError('Redirect cycle detected', 'FETCH_FAILED', false);
    }
    visited.add(current);
    // SSRF pre-flight: resolve DNS & reject private/loopback IPs.
    // NOTE: fetch() below re-resolves DNS independently — a DNS rebinding
    // attack can slip through this check.  See JSDoc above.
    // TODO V2: Pin resolved IPs to fetch connections via custom undici dispatcher to prevent DNS rebinding
    await validateSsrfIfEnabled(current, ssrfValidationEnabled);
    const res = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Goldpan/1.0; +https://github.com/user/goldpan)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      },
    });
    if (REDIRECT_STATUSES.includes(res.status)) {
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (!location) {
        throw new CollectorError('Redirect without Location header', 'FETCH_FAILED', false);
      }
      const resolved = new URL(location, current);
      if (!['http:', 'https:'].includes(resolved.protocol)) {
        throw new CollectorError('Redirect to non-HTTP protocol', 'FETCH_FAILED', false);
      }
      current = resolved.toString();
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new CollectorError(`Unexpected ${res.status} response`, 'FETCH_FAILED', false);
    }
    return { response: res, finalUrl: current };
  }
  throw new CollectorError('Too many redirects', 'FETCH_FAILED', true);
}
