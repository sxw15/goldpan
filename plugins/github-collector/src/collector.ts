import type { CollectorInput, CollectorOutput, CollectorPlugin } from '@goldpan/core/plugins';
import { CollectorError } from '@goldpan/core/plugins';
import type { GithubApiClient } from './api.js';
import { buildIncrementalContent, buildInitialContent } from './content-builder.js';
import { parseOwnerRepo } from './parser.js';

export interface GithubCollectorConfig {
  token: string | undefined;
  apiBase: string;
  timeoutMs: number;
  commitsLimit: number;
  releasesLimit: number;
  maxContentLength: number;
  cleanReadme: boolean;
}

export interface PriorSource {
  metadata: Record<string, unknown>;
}

export interface GithubCollectorDeps {
  apiClient: GithubApiClient;
  config: GithubCollectorConfig;
  dbLookup: {
    getLatestConfirmed(normalizedUrl: string): Promise<PriorSource | null>;
  };
}

export function createGithubCollector(deps: GithubCollectorDeps): CollectorPlugin {
  return {
    name: 'collector-github',
    type: 'collector',
    version: '0.1.0',
    description: 'GitHub repository collector',
    priority: 20,
    canHandle(input: CollectorInput): boolean {
      if (typeof input.url !== 'string') return false;
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        return false;
      }
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      if (!['github.com', 'www.github.com'].includes(url.hostname)) return false;
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length < 2) return false;
      const sub = segments[2];
      if (!sub) return true;
      return ['tree', 'blob', 'commit', 'commits', 'releases'].includes(sub);
    },
    async collect(input: CollectorInput, signal: AbortSignal): Promise<CollectorOutput> {
      const { owner, repo, normalizedUrl } = parseOwnerRepo(input.url);
      const prior = await deps.dbLookup.getLatestConfirmed(normalizedUrl);
      if (!prior) {
        return collectInitial({ owner, repo, signal, deps });
      }
      return collectIncremental({ owner, repo, signal, prior, deps });
    },
  };
}

async function collectInitial(args: {
  owner: string;
  repo: string;
  signal: AbortSignal;
  deps: GithubCollectorDeps;
}): Promise<CollectorOutput> {
  const { owner, repo, signal, deps } = args;
  const { apiClient, config } = deps;

  const [repoMeta, readmeRes, releasesRes, commitsRes, changelogRes] = await Promise.all([
    apiClient.getRepo({ owner, repo, signal }),
    apiClient.getReadme({ owner, repo, signal }).catch(maybeNull),
    apiClient.getReleases({ owner, repo, signal, perPage: config.releasesLimit }),
    apiClient.getCommits({ owner, repo, signal, perPage: config.commitsLimit }),
    apiClient.getChangelog({ owner, repo, signal }).catch(maybeNull),
  ]);
  if (repoMeta.status !== 200) throw new CollectorError('Expected repo body', 'UPSTREAM', true);
  const meta = repoMeta.body;

  const archived = (meta as { archived?: boolean }).archived === true;
  const archivedAt = (meta as { archived_at?: string | null }).archived_at ?? null;

  let changelog: string | null = null;
  let changelogEtag: string | null = null;
  if (changelogRes?.status === 200) {
    const body = changelogRes.body as { content?: string; encoding?: string };
    if (body.encoding === 'base64' && typeof body.content === 'string') {
      changelog = Buffer.from(body.content, 'base64').toString('utf-8');
      changelogEtag = changelogRes.etag;
    }
  }

  const readme = readmeRes?.status === 200 ? (readmeRes.body as string) : null;
  const readmeEtag = readmeRes?.status === 200 ? readmeRes.etag : null;
  const releases = releasesRes.status === 200 ? releasesRes.body : [];
  const releasesEtag = releasesRes.status === 200 ? releasesRes.etag : null;
  const commits = commitsRes.status === 200 ? commitsRes.body : [];
  const commitsEtag = commitsRes.status === 200 ? commitsRes.etag : null;

  const built = buildInitialContent({
    repoMeta: meta,
    readme,
    releases,
    commits,
    changelog,
    cleanReadme: config.cleanReadme,
    maxContentLength: config.maxContentLength,
  });

  return {
    content: built.content,
    title: String((meta as { full_name?: string }).full_name ?? `${owner}/${repo}`),
    finalUrl: `https://github.com/${owner}/${repo}`,
    metadata: {
      collector_update_mode: 'initial',
      collector_github_owner: owner,
      collector_github_repo: repo,
      collector_github_default_branch: String(
        (meta as { default_branch?: string }).default_branch ?? 'main',
      ),
      collector_github_last_commit_sha: built.watermarks.lastCommitSha,
      collector_github_last_release_tag: built.watermarks.lastReleaseTag,
      collector_github_readme_hash: built.watermarks.readmeHash,
      collector_github_changelog_hash: built.watermarks.changelogHash,
      collector_github_etag_meta: repoMeta.etag,
      collector_github_etag_readme: readmeEtag,
      collector_github_etag_releases: releasesEtag,
      collector_github_etag_commits: commitsEtag,
      collector_github_etag_changelog: changelogEtag,
      collector_github_archived: archived,
      collector_github_archived_at: archivedAt,
      collector_github_readme_original_size: built.readmeOriginalSize,
      collector_github_readme_cleaned_size: built.readmeCleanedSize,
      collector_github_readme_sent_size: built.readmeSentSize,
      collector_github_readme_truncated: built.readmeTruncated,
      collector_github_collected_at: new Date().toISOString(),
    },
  };
}

async function collectIncremental(args: {
  owner: string;
  repo: string;
  signal: AbortSignal;
  prior: PriorSource;
  deps: GithubCollectorDeps;
}): Promise<CollectorOutput> {
  const { owner, repo, signal, prior, deps } = args;
  const { apiClient, config } = deps;
  const pm = prior.metadata;

  const [metaRes, readmeRes, releasesRes, commitsRes, changelogRes] = await Promise.all([
    apiClient.getRepo({
      owner,
      repo,
      signal,
      etag: String(pm.collector_github_etag_meta ?? '') || null,
    }),
    apiClient
      .getReadme({
        owner,
        repo,
        signal,
        etag: String(pm.collector_github_etag_readme ?? '') || null,
      })
      .catch(maybeNull),
    apiClient.getReleases({
      owner,
      repo,
      signal,
      perPage: config.releasesLimit,
      etag: String(pm.collector_github_etag_releases ?? '') || null,
    }),
    apiClient.getCommits({
      owner,
      repo,
      signal,
      perPage: config.commitsLimit,
      etag: String(pm.collector_github_etag_commits ?? '') || null,
    }),
    apiClient
      .getChangelog({
        owner,
        repo,
        signal,
        etag: String(pm.collector_github_etag_changelog ?? '') || null,
      })
      .catch(maybeNull),
  ]);

  const allUnchanged =
    metaRes.status === 304 &&
    (readmeRes === null || readmeRes.status === 304) &&
    releasesRes.status === 304 &&
    commitsRes.status === 304 &&
    (changelogRes === null || changelogRes.status === 304);
  if (allUnchanged) {
    throw new CollectorError(
      'No updates since last analysis',
      'CONTENT_EMPTY',
      false,
      undefined,
      false,
    );
  }

  const defaultBranch = String(pm.collector_github_default_branch ?? 'main');
  const meta =
    metaRes.status === 200
      ? metaRes.body
      : { full_name: `${owner}/${repo}`, default_branch: defaultBranch };
  const readme = readmeRes?.status === 200 ? (readmeRes.body as string) : null;
  const lastTag = String(pm.collector_github_last_release_tag ?? '');
  const lastSha = String(pm.collector_github_last_commit_sha ?? '');
  const newReleases =
    releasesRes.status === 200
      ? takeUntilWatermark(
          releasesRes.body,
          (r) => String((r as { tag_name: string }).tag_name),
          lastTag,
        )
      : [];
  const newCommits =
    commitsRes.status === 200
      ? takeUntilWatermark(commitsRes.body, (c) => String((c as { sha: string }).sha), lastSha)
      : [];
  let changelog: string | null = null;
  if (changelogRes?.status === 200) {
    const body = changelogRes.body as { content?: string; encoding?: string };
    if (body.encoding === 'base64' && typeof body.content === 'string') {
      changelog = Buffer.from(body.content, 'base64').toString('utf-8');
    }
  }

  const built = buildIncrementalContent({
    repoMeta: meta,
    readme,
    releases: newReleases,
    commits: newCommits,
    changelog,
    cleanReadme: config.cleanReadme,
    maxContentLength: config.maxContentLength,
    ownerSlashRepo: `${owner}/${repo}`,
  });

  return {
    content: built.content,
    title: String((meta as { full_name?: string }).full_name ?? `${owner}/${repo}`),
    finalUrl: `https://github.com/${owner}/${repo}`,
    metadata: {
      ...prior.metadata,
      collector_update_mode: 'incremental',
      collector_github_last_commit_sha:
        built.watermarks.lastCommitSha ?? pm.collector_github_last_commit_sha,
      collector_github_last_release_tag:
        built.watermarks.lastReleaseTag ?? pm.collector_github_last_release_tag,
      collector_github_readme_hash: built.watermarks.readmeHash ?? pm.collector_github_readme_hash,
      collector_github_changelog_hash:
        built.watermarks.changelogHash ?? pm.collector_github_changelog_hash,
      collector_github_etag_meta:
        metaRes.status === 200 ? metaRes.etag : pm.collector_github_etag_meta,
      collector_github_etag_readme:
        readmeRes?.status === 200 ? readmeRes.etag : pm.collector_github_etag_readme,
      collector_github_etag_releases:
        releasesRes.status === 200 ? releasesRes.etag : pm.collector_github_etag_releases,
      collector_github_etag_commits:
        commitsRes.status === 200 ? commitsRes.etag : pm.collector_github_etag_commits,
      collector_github_etag_changelog:
        changelogRes?.status === 200 ? changelogRes.etag : pm.collector_github_etag_changelog,
      collector_github_archived:
        Boolean((meta as { archived?: boolean }).archived) || Boolean(pm.collector_github_archived),
      collector_github_archived_at:
        (meta as { archived_at?: string | null }).archived_at ??
        pm.collector_github_archived_at ??
        null,
      collector_github_readme_original_size: built.readmeOriginalSize,
      collector_github_readme_cleaned_size: built.readmeCleanedSize,
      collector_github_readme_sent_size: built.readmeSentSize,
      collector_github_readme_truncated: built.readmeTruncated,
      collector_github_collected_at: new Date().toISOString(),
    },
  };
}

function isNotFound(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code?: unknown }).code === 'NOT_FOUND';
  }
  return false;
}

function maybeNull(err: unknown): null {
  if (isNotFound(err)) return null;
  throw err;
}

// GitHub list endpoints return newest-first. Scan until we hit the prior
// watermark; everything before it is new. Plain `filter(!== watermark)`
// would re-include items older than the watermark as if they were new.
function takeUntilWatermark<T>(items: T[], getKey: (item: T) => string, watermark: string): T[] {
  if (!watermark) return items;
  const idx = items.findIndex((item) => getKey(item) === watermark);
  return idx >= 0 ? items.slice(0, idx) : items;
}
