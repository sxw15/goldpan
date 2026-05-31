/**
 * Strips the top-level `__internal` namespace from a metadata object.
 *
 * `__internal` will hold server-side state that must not leak to web UI bubbles
 * or to classifier prompt context — for example `classifierDecision` (P3) and
 * any buffer-mechanism tracking fields. The repository layer applies this strip
 * unconditionally so every read path is safe; the HTTP layer applies it again
 * as defense in depth.
 */
export function stripInternalKeys(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  const { __internal: _ignored, ...rest } = metadata;
  return rest;
}
