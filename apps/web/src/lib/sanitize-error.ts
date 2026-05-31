/**
 * Strip identifying network metadata from an Error message before showing it
 * to the user. Self-host operators routinely paste toast text into GitHub
 * issues, Discord, or Discourse posts; the unredacted form leaks the host /
 * IP / port of their internal services, which is information the report
 * recipient doesn't need and the operator may not realize they're sharing.
 *
 * Substitutions:
 * - Full URLs (http://… https://…) → `<url>` — Node's `fetch` error path
 *   surfaces the target URL inside the message ("fetch failed at …")
 * - IPv4 literals (with optional :port) → `<host>` — covers
 *   `ECONNREFUSED 192.168.1.10:8443` and `cert invalid for 10.0.0.5`
 * - Stack trace tail (everything after the first newline) is dropped — toast
 *   content is one-liner UI; the full stack is preserved in console.error
 *   which the operator can copy if a maintainer asks.
 *
 * IPv6 is deliberately NOT scrubbed: a reliable IPv6 regex is much more
 * footgun-prone than the scenarios above (false positives on hex tokens,
 * UUID fragments, etc.). Maintainers who need to debug an IPv6-only setup
 * have the console-side detail; the user-visible toast just shows what's
 * left after URL stripping.
 *
 * Output is capped at 200 characters to prevent a single absurd error
 * (e.g. server stack dump rendered as one line) from blowing out the toast.
 */
export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n', 1)[0] ?? '';
  const noUrls = firstLine.replace(/https?:\/\/\S+/gi, '<url>');
  const noIpv4 = noUrls.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<host>');
  return noIpv4.length > 200 ? `${noIpv4.slice(0, 200)}…` : noIpv4;
}
