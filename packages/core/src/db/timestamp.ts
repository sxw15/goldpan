/**
 * Current UTC instant as epoch milliseconds (INTEGER). All DB time columns
 * store this exact representation.
 */
export function utcNowMs(): number {
  return Date.now();
}

/** Convert a `Date` to epoch milliseconds for DB writes. */
export function dateToMs(d: Date): number {
  return d.getTime();
}
