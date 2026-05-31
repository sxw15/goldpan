// Default import: namespace import breaks under Node ESM (`ipaddr.isValid` is undefined; API lives on `default`).
import ipaddr from 'ipaddr.js';

const ALLOWED_RANGES = new Set(['unicast']);
const DNS_TIMEOUT_MS = 10_000;

export function isPrivateIp(ip: string): boolean {
  // Reject non-standard encodings (octal 0177, hex 0x7f, integer format)
  if (!ip.includes(':')) {
    const octets = ip.split('.');
    if (octets.length !== 4) {
      throw new Error(`Non-standard IP encoding rejected: ${ip}`);
    }
    for (const octet of octets) {
      if (/^0[xX]/.test(octet) || (/^0\d+/.test(octet) && octet !== '0')) {
        throw new Error(`Non-standard IP encoding rejected: ${ip}`);
      }
    }
  }

  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    throw new Error(`Invalid IP address: ${ip}`);
  }

  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      const v4 = v6.toIPv4Address();
      return !ALLOWED_RANGES.has(v4.range());
    }
  }

  return !ALLOWED_RANGES.has(addr.range());
}

const NON_STANDARD_OCTET = /^0\d/;

function hasNonStandardIpEncoding(rawHost: string): boolean {
  const host = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;
  if (!host) return false;

  // Single hex number (e.g., 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  // Single integer (e.g., 2130706433)
  if (/^\d+$/.test(host)) return true;

  const parts = host.split('.');
  // Only check dotted parts that look numeric/hex
  if (parts.some((p) => !/^[0-9a-fA-FxX]+$/.test(p))) return false;

  if (parts.some((p) => /^0x/i.test(p))) return true;
  if (parts.some((p) => NON_STANDARD_OCTET.test(p))) return true;
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p))) return true;
  if (
    parts.length === 4 &&
    parts.every((p) => /^\d+$/.test(p)) &&
    parts.some((p) => parseInt(p, 10) > 255)
  )
    return true;

  return false;
}

function extractRawHostname(urlString: string): string | null {
  const authorityMatch = urlString.match(/^https?:\/\/([^\\/?#]+)/i);
  if (!authorityMatch) return null;
  let authority = authorityMatch[1];
  const atIndex = authority.lastIndexOf('@');
  if (atIndex !== -1) {
    authority = authority.slice(atIndex + 1);
  }
  if (authority.startsWith('[')) {
    const closeBracket = authority.indexOf(']');
    if (closeBracket !== -1) {
      return authority.slice(1, closeBracket) || null;
    }
  }
  const colonIndex = authority.lastIndexOf(':');
  if (colonIndex !== -1) {
    authority = authority.slice(0, colonIndex);
  }
  return authority || null;
}

/**
 * Wrapper that no-ops when `enabled === false`. Centralizes the
 * `GOLDPAN_SSRF_VALIDATION_ENABLED` opt-out so call sites stay one-liners
 * and a future audit can grep one symbol to find every "respects the flag"
 * call site (vs. the unconditional `validateSsrf`, kept for hardcoded
 * invariants like Ollama-loopback that should not be opt-out-able).
 *
 * Tests that need to assert "the SSRF check ran" should mock this function,
 * not `validateSsrf` — the wrapper resolves `validateSsrf` internally, so
 * stubbing the latter via `vi.mock` does not intercept calls made through
 * the wrapper.
 */
export async function validateSsrfIfEnabled(urlString: string, enabled: boolean): Promise<void> {
  if (!enabled) return;
  await validateSsrf(urlString);
}

export async function validateSsrf(urlString: string): Promise<void> {
  const input = urlString.trim();

  const rawHost = extractRawHostname(input);
  if (rawHost) {
    if (hasNonStandardIpEncoding(rawHost)) {
      throw new Error(`Non-standard IP encoding rejected: ${rawHost}`);
    }
    try {
      const decoded = decodeURIComponent(rawHost);
      if (decoded !== rawHost && hasNonStandardIpEncoding(decoded)) {
        throw new Error(`Non-standard IP encoding rejected (encoded): ${rawHost}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Non-standard IP encoding')) {
        throw err;
      }
      /* ignore malformed URI sequences (URIError from decodeURIComponent) */
    }
  }

  const url = new URL(input);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Protocol not allowed: ${url.protocol}`);
  }

  // Strip brackets from IPv6 hostname — some Node.js versions include them
  let hostname = url.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  if (ipaddr.isValid(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`URL targets private/reserved IP: ${hostname}`);
    }
    return;
  }

  // DNS resolution — MUST use `(await import('node:dns')).promises` for test mockability
  const dns = await import('node:dns');
  const results: string[] = [];

  const isNoRecordError = (err: unknown): boolean => {
    const code = (err as { code?: string }).code;
    return code === 'ENOTFOUND' || code === 'ENODATA';
  };

  const withTimeout = <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS resolution timed out for ${hostname}`)),
          DNS_TIMEOUT_MS,
        );
      }),
    ]);
  };

  // Resolve IPv4 and IPv6 in parallel for faster SSRF validation
  const [v4Result, v6Result] = await Promise.allSettled([
    withTimeout(dns.promises.resolve4(hostname)),
    withTimeout(dns.promises.resolve6(hostname)),
  ]);

  const dnsErrors: Error[] = [];
  for (const r of [v4Result, v6Result]) {
    if (r.status === 'fulfilled') {
      results.push(...r.value);
    } else if (!isNoRecordError(r.reason)) {
      dnsErrors.push(r.reason as Error);
    }
  }

  if (results.length === 0 && dnsErrors.length > 0) {
    throw new Error(`DNS resolution error for ${hostname}: ${dnsErrors[0].message}`);
  }

  if (results.length === 0) {
    throw new Error(`DNS resolution failed for: ${hostname}`);
  }

  for (const ip of results) {
    if (isPrivateIp(ip)) {
      throw new Error('URL targets a private or reserved network address');
    }
  }
}
