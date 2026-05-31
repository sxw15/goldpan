export interface SecretResolver {
  /**
   * Resolves a secret reference into a plain string.
   *
   * - `env://VAR_NAME` → `process.env.VAR_NAME` (throws if missing).
   * - Anything else without `://` → returned as-is (treated as a literal).
   * - Anything else with `://` → throws (unsupported scheme).
   */
  resolve(ref: string): string;
}
