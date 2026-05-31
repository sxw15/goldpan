import { createHash } from 'node:crypto';
import { rewriteMarkdownLinks } from './markdown-rewrite.js';
import { cleanReadmeForExtraction } from './readme-cleaner.js';

export interface BuildArgs {
  repoMeta: Record<string, unknown>;
  readme: string | null;
  releases: Array<Record<string, unknown>>;
  commits: Array<Record<string, unknown>>;
  changelog: string | null;
  cleanReadme: boolean;
  maxContentLength: number;
}

export interface BuildResult {
  content: string;
  watermarks: {
    lastCommitSha: string | null;
    lastReleaseTag: string | null;
    readmeHash: string | null;
    changelogHash: string | null;
  };
  readmeOriginalSize: number;
  readmeCleanedSize: number;
  readmeSentSize: number;
  readmeTruncated: boolean;
}

function sha256(s: string): string {
  return `sha256:${createHash('sha256').update(s).digest('hex')}`;
}

/**
 * Truncate `s` so its UTF-8 byte length is ≤ `maxBytes`, without splitting a
 * multi-byte codepoint. `String.prototype.slice` works in UTF-16 code units,
 * so slicing against a byte budget can overflow 2–3× for CJK/emoji input.
 */
function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  let end = maxBytes;
  // UTF-8 continuation bytes are 10xxxxxx (0x80..0xBF). If we land mid-
  // codepoint, walk back to the first byte of that codepoint so the decoded
  // string is never invalid.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

export function buildInitialContent(args: BuildArgs): BuildResult {
  const parts: string[] = [];
  const m = args.repoMeta;
  const fullName = String(m.full_name ?? '');
  const [owner, repo] = fullName.split('/');
  const defaultBranch = String(m.default_branch ?? 'main');

  parts.push(
    [
      '[Repo Meta]',
      `- name: ${m.name ?? repo}`,
      `- full_name: ${fullName}`,
      `- description: ${m.description ?? ''}`,
      `- default_branch: ${defaultBranch}`,
      `- language: ${m.language ?? ''}`,
      `- stars: ${m.stargazers_count ?? 0}`,
      `- forks: ${m.forks_count ?? 0}`,
      `- license: ${
        m.license && typeof m.license === 'object' && 'spdx_id' in m.license
          ? (m.license as { spdx_id: string }).spdx_id
          : ''
      }`,
      `- topics: ${Array.isArray(m.topics) ? (m.topics as string[]).join(', ') : ''}`,
      `- archived: ${m.archived ?? false}`,
      `- fork: ${m.fork ?? false}`,
      `- created_at: ${m.created_at ?? ''}`,
      `- pushed_at: ${m.pushed_at ?? ''}`,
    ].join('\n'),
  );

  const readmeOriginal = args.readme ?? '';
  const readmeCleaned = args.cleanReadme
    ? cleanReadmeForExtraction(readmeOriginal)
    : readmeOriginal;
  const readmeRewritten = rewriteMarkdownLinks(readmeCleaned, { owner, repo, defaultBranch });
  let readmeSent = readmeRewritten;
  let readmeTruncated = false;
  if (Buffer.byteLength(readmeSent, 'utf8') > args.maxContentLength) {
    readmeSent = truncateUtf8(readmeSent, args.maxContentLength);
    readmeTruncated = true;
  }
  if (readmeSent) {
    parts.push(
      `[README]\n${readmeSent}${readmeTruncated ? `\n\n... (truncated, original size: ${Buffer.byteLength(readmeOriginal, 'utf8')} bytes)` : ''}`,
    );
  }

  if (args.releases.length > 0) {
    const lines = args.releases.map((r) => {
      const tag = r.tag_name ?? '';
      const at = r.published_at ?? '';
      const body = typeof r.body === 'string' ? r.body : '';
      return `- ${tag} (${at}): ${body}`;
    });
    parts.push(`[Recent Releases (latest ${args.releases.length})]\n${lines.join('\n')}`);
  }

  if (args.commits.length > 0) {
    const lines = args.commits.map((c) => {
      const sha = String(c.sha ?? '').slice(0, 7);
      const commit = c.commit as
        | { message?: string; author?: { date?: string; name?: string } }
        | undefined;
      const date = commit?.author?.date ?? '';
      const name = commit?.author?.name ?? '';
      const subject = (commit?.message ?? '').split('\n')[0];
      return `- ${sha} (${date}, ${name}): ${subject}`;
    });
    parts.push(`[Recent Commits (last ${args.commits.length})]\n${lines.join('\n')}`);
  }

  let changelogFinal: string | null = null;
  if (args.changelog) {
    changelogFinal =
      Buffer.byteLength(args.changelog, 'utf8') > args.maxContentLength
        ? truncateUtf8(args.changelog, args.maxContentLength)
        : args.changelog;
    parts.push(`[CHANGELOG.md]\n${changelogFinal}`);
  }

  return {
    content: parts.join('\n\n'),
    watermarks: {
      lastCommitSha:
        typeof args.commits[0]?.sha === 'string' ? (args.commits[0].sha as string) : null,
      lastReleaseTag:
        typeof args.releases[0]?.tag_name === 'string'
          ? (args.releases[0].tag_name as string)
          : null,
      readmeHash: readmeOriginal ? sha256(readmeOriginal) : null,
      changelogHash: args.changelog ? sha256(args.changelog) : null,
    },
    readmeOriginalSize: Buffer.byteLength(readmeOriginal, 'utf8'),
    readmeCleanedSize: Buffer.byteLength(readmeCleaned, 'utf8'),
    readmeSentSize: Buffer.byteLength(readmeSent, 'utf8'),
    readmeTruncated,
  };
}

/** Incremental output: only includes sections that changed (non-304). Same shape. */
export function buildIncrementalContent(args: BuildArgs & { ownerSlashRepo: string }): BuildResult {
  const result = buildInitialContent(args);
  return {
    ...result,
    content: `[Project Update — ${args.ownerSlashRepo}]\n\n${result.content}`,
  };
}
