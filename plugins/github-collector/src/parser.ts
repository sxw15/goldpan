export interface ParsedRepo {
  owner: string;
  repo: string;
  normalizedUrl: string;
  subPath?: string;
}

export function parseOwnerRepo(rawUrl: string): ParsedRepo {
  const url = new URL(rawUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Cannot extract owner/repo from URL: ${rawUrl}`);
  }
  const normalizedUrl = buildNormalizedUrl(segments[0], segments[1]);
  // Re-derive owner + repo from the canonical URL so they match normalizedUrl exactly.
  const [owner, repo] = new URL(normalizedUrl).pathname.split('/').filter(Boolean);
  const subPath = segments.slice(2).join('/') || undefined;
  return { owner, repo, normalizedUrl, subPath };
}

export function buildNormalizedUrl(owner: string, repo: string): string {
  // Strip trailing `.git` so `facebook/react` and `facebook/react.git`
  // collapse to the same canonical URL (normalizedUrl is a primary key).
  const cleanRepo = repo.replace(/\.git$/i, '');
  return `https://github.com/${owner}/${cleanRepo}`.toLowerCase();
}
