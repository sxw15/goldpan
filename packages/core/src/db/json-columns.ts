/**
 * Helpers for SQLite columns that store JSON-encoded arrays.
 * All variants tolerate null / invalid JSON / non-array input by returning `[]`,
 * and silently drop elements that don't match the expected element type.
 */

export function parseJsonStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function parseJsonNumberArray(json: string | null | undefined): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    return [];
  }
}
