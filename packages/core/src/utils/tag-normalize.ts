/**
 * Canonicalize a list of hashtag-style tag strings into a deduped array.
 *
 * Rules:
 * - Trim each entry; drop empty strings.
 * - Dedupe case-insensitively. The **first occurrence wins** for display
 *   casing — e.g. `["React", "react", "REACT"]` → `["React"]`.
 *
 * Used at two layers (extractor pipeline boundary + tags repo write boundary)
 * which need to agree exactly on what counts as "the same tag" — keeping the
 * logic in one place prevents the two from drifting out of sync.
 */
export function normalizeTags(input: readonly string[] | undefined): string[] {
  if (!input || input.length === 0) return [];
  const seen = new Map<string, string>();
  for (const raw of input) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return Array.from(seen.values());
}
