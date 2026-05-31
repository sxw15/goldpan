import { describe, expect, it, vi } from 'vitest';
import { createGithubCollector } from '../src/collector.js';

const baseDeps = {
  db: {
    /* drizzle test db, see tests/_helpers for full setup */
  } as any,
  config: {
    token: undefined,
    apiBase: 'https://api.github.com',
    timeoutMs: 1000,
    commitsLimit: 20,
    releasesLimit: 10,
    maxContentLength: 200_000,
    cleanReadme: true,
  },
};

describe('collector.canHandle', () => {
  const plugin = createGithubCollector({
    ...baseDeps,
    apiClient: {} as any,
    dbLookup: undefined as any,
  });
  it('accepts /owner/repo', () => {
    expect(plugin.canHandle({ url: 'https://github.com/facebook/react' })).toBe(true);
  });
  it('accepts /owner/repo/tree/branch', () => {
    expect(plugin.canHandle({ url: 'https://github.com/facebook/react/tree/main' })).toBe(true);
  });
  it('rejects /owner/repo/issues', () => {
    expect(plugin.canHandle({ url: 'https://github.com/facebook/react/issues/1' })).toBe(false);
  });
  it('rejects non-github host', () => {
    expect(plugin.canHandle({ url: 'https://gitlab.com/o/r' })).toBe(false);
  });
  it('rejects /owner alone', () => {
    expect(plugin.canHandle({ url: 'https://github.com/facebook' })).toBe(false);
  });
});

const testSignal = () => new AbortController().signal;

describe('collector.collect — initial path', () => {
  it('returns content + collector_update_mode=initial when no prior source exists', async () => {
    const apiClient = {
      getRepo: vi.fn().mockResolvedValue({
        status: 200,
        etag: 'W/"m"',
        body: { full_name: 'o/r', default_branch: 'main' },
      }),
      getReadme: vi.fn().mockResolvedValue({ status: 200, etag: 'W/"r"', body: '# Hello' }),
      getReleases: vi.fn().mockResolvedValue({ status: 200, etag: 'W/"rel"', body: [] }),
      getCommits: vi.fn().mockResolvedValue({ status: 200, etag: 'W/"c"', body: [] }),
      getChangelog: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('nf'), { code: 'NOT_FOUND' })),
    };
    const plugin = createGithubCollector({
      ...baseDeps,
      apiClient: apiClient as any,
      dbLookup: { getLatestConfirmed: async () => null },
    });
    const out = await plugin.collect({ url: 'https://github.com/o/r' }, testSignal());
    expect(out.metadata?.collector_update_mode).toBe('initial');
    expect(out.metadata?.collector_github_owner).toBe('o');
    expect(out.content).toContain('[Repo Meta]');
  });
});

describe('collector.collect — incremental watermark scan', () => {
  it('stops at lastSha watermark in commit list (does not re-include older commits)', async () => {
    const apiClient = {
      getRepo: vi.fn().mockResolvedValue({ status: 304 }),
      getReadme: vi.fn().mockResolvedValue({ status: 304 }),
      getReleases: vi.fn().mockResolvedValue({ status: 200, etag: 'W/"rel"', body: [] }),
      getCommits: vi.fn().mockResolvedValue({
        status: 200,
        etag: 'W/"c"',
        body: [
          {
            sha: 'newA',
            commit: { message: 'feat: new A', author: { date: '2026-04-02', name: 'd' } },
          },
          {
            sha: 'newB',
            commit: { message: 'feat: new B', author: { date: '2026-04-01', name: 'd' } },
          },
          {
            sha: 'watermark',
            commit: { message: 'prev head', author: { date: '2026-03-31', name: 'd' } },
          },
          { sha: 'old1', commit: { message: 'old 1', author: { date: '2026-03-30', name: 'd' } } },
          { sha: 'old2', commit: { message: 'old 2', author: { date: '2026-03-29', name: 'd' } } },
        ],
      }),
      getChangelog: vi.fn().mockResolvedValue({ status: 304 }),
    };
    const plugin = createGithubCollector({
      ...baseDeps,
      apiClient: apiClient as any,
      dbLookup: {
        getLatestConfirmed: async () => ({
          metadata: {
            collector_github_etag_meta: 'x',
            collector_github_etag_readme: 'x',
            collector_github_etag_releases: 'x',
            collector_github_etag_commits: 'x',
            collector_github_etag_changelog: 'x',
            collector_github_default_branch: 'main',
            collector_github_last_commit_sha: 'watermark',
            collector_github_last_release_tag: 'v1',
          },
        }),
      },
    });
    const out = await plugin.collect({ url: 'https://github.com/o/r' }, testSignal());
    expect(out.content).toContain('newA');
    expect(out.content).toContain('newB');
    expect(out.content).not.toContain('old1');
    expect(out.content).not.toContain('old2');
    expect(out.content).not.toContain('watermark');
  });

  it('stops at lastTag watermark in release list (does not re-include older releases)', async () => {
    const apiClient = {
      getRepo: vi.fn().mockResolvedValue({ status: 304 }),
      getReadme: vi.fn().mockResolvedValue({ status: 304 }),
      getReleases: vi.fn().mockResolvedValue({
        status: 200,
        etag: 'W/"rel"',
        body: [
          { tag_name: 'v2.1', published_at: '2026-04-02', body: 'release v2.1' },
          { tag_name: 'v2.0', published_at: '2026-04-01', body: 'release v2.0' },
          { tag_name: 'v1', published_at: '2026-03-31', body: 'release v1' },
          { tag_name: 'v0.9', published_at: '2026-03-30', body: 'release v0.9' },
        ],
      }),
      getCommits: vi.fn().mockResolvedValue({ status: 200, etag: 'W/"c"', body: [] }),
      getChangelog: vi.fn().mockResolvedValue({ status: 304 }),
    };
    const plugin = createGithubCollector({
      ...baseDeps,
      apiClient: apiClient as any,
      dbLookup: {
        getLatestConfirmed: async () => ({
          metadata: {
            collector_github_etag_meta: 'x',
            collector_github_etag_readme: 'x',
            collector_github_etag_releases: 'x',
            collector_github_etag_commits: 'x',
            collector_github_etag_changelog: 'x',
            collector_github_default_branch: 'main',
            collector_github_last_commit_sha: 'abc',
            collector_github_last_release_tag: 'v1',
          },
        }),
      },
    });
    const out = await plugin.collect({ url: 'https://github.com/o/r' }, testSignal());
    expect(out.content).toContain('v2.1');
    expect(out.content).toContain('v2.0');
    expect(out.content).not.toContain('v0.9');
    expect(out.content).not.toContain('release v1');
  });
});

describe('collector.collect — incremental watermark out of page', () => {
  it('treats every returned commit as new when watermark is older than the page window', async () => {
    const apiClient = {
      getRepo: vi.fn().mockResolvedValue({ status: 304 }),
      getReadme: vi.fn().mockResolvedValue({ status: 304 }),
      getReleases: vi.fn().mockResolvedValue({ status: 200, etag: 'W/"rel"', body: [] }),
      getCommits: vi.fn().mockResolvedValue({
        status: 200,
        etag: 'W/"c"',
        body: [
          { sha: 'x1', commit: { message: 'c1', author: { date: '2026-04-02', name: 'd' } } },
          { sha: 'x2', commit: { message: 'c2', author: { date: '2026-04-01', name: 'd' } } },
        ],
      }),
      getChangelog: vi.fn().mockResolvedValue({ status: 304 }),
    };
    const plugin = createGithubCollector({
      ...baseDeps,
      apiClient: apiClient as any,
      dbLookup: {
        getLatestConfirmed: async () => ({
          metadata: {
            collector_github_etag_meta: 'x',
            collector_github_etag_readme: 'x',
            collector_github_etag_releases: 'x',
            collector_github_etag_commits: 'x',
            collector_github_etag_changelog: 'x',
            collector_github_default_branch: 'main',
            collector_github_last_commit_sha: 'sha-that-fell-off-the-page',
            collector_github_last_release_tag: 'v1',
          },
        }),
      },
    });
    const out = await plugin.collect({ url: 'https://github.com/o/r' }, testSignal());
    expect(out.content).toContain('x1');
    expect(out.content).toContain('x2');
  });
});

describe('collector.collect — incremental path with all-304', () => {
  it('throws CONTENT_EMPTY when every endpoint returns 304', async () => {
    const apiClient = {
      getRepo: vi.fn().mockResolvedValue({ status: 304 }),
      getReadme: vi.fn().mockResolvedValue({ status: 304 }),
      getReleases: vi.fn().mockResolvedValue({ status: 304 }),
      getCommits: vi.fn().mockResolvedValue({ status: 304 }),
      getChangelog: vi.fn().mockResolvedValue({ status: 304 }),
    };
    const plugin = createGithubCollector({
      ...baseDeps,
      apiClient: apiClient as any,
      dbLookup: {
        getLatestConfirmed: async () => ({
          metadata: {
            collector_github_etag_meta: 'x',
            collector_github_etag_readme: 'x',
            collector_github_etag_releases: 'x',
            collector_github_etag_commits: 'x',
            collector_github_etag_changelog: 'x',
            collector_github_default_branch: 'main',
            collector_github_last_commit_sha: 'abc',
            collector_github_last_release_tag: 'v1',
          },
        }),
      },
    });
    await expect(
      plugin.collect({ url: 'https://github.com/o/r' }, testSignal()),
    ).rejects.toMatchObject({
      code: 'CONTENT_EMPTY',
    });
  });
});
