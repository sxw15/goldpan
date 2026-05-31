import type { DrizzleDB } from '@goldpan/core/db';
import { processingTasks, sources } from '@goldpan/core/db/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDB } from '../../../packages/core/tests/helpers/test-db';
import { GithubService } from '../src/service.js';

describe('GithubService.refreshRepoByNormalizedUrl', () => {
  let db: DrizzleDB;
  let cleanup: () => void;
  let service: GithubService;

  beforeEach(() => {
    const h = createTestDB();
    db = h.db;
    cleanup = h.cleanup;
    service = new GithubService({ db, cooldownSec: 60 });
  });
  afterEach(() => cleanup());

  it("first call returns { status: 'started' } and inserts one source + task", async () => {
    const result = await service.refreshRepoByNormalizedUrl('https://github.com/o/r');
    expect(result.status).toBe('started');
    const rows = db.select().from(sources).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe('github_refresh');
    expect(rows[0].kind).toBe('external');
    expect(rows[0].status).toBe('processing');
    const tasks = db.select().from(processingTasks).all();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('pipeline');
  });

  it("second immediate call returns { status: 'in_progress' } with same source", async () => {
    const first = await service.refreshRepoByNormalizedUrl('https://github.com/o/r');
    const second = await service.refreshRepoByNormalizedUrl('https://github.com/o/r');
    expect(second.status).toBe('in_progress');
    if (second.status === 'in_progress' && first.status === 'started') {
      expect(second.sourceId).toBe(first.sourceId);
      expect(typeof second.startedAt).toBe('number');
    }
  });

  it('Promise.all of 20 concurrent calls yields exactly one started', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.refreshRepoByNormalizedUrl('https://github.com/o/r'),
      ),
    );
    const started = results.filter((r) => r.status === 'started');
    const inProgress = results.filter((r) => r.status === 'in_progress');
    expect(started).toHaveLength(1);
    expect(inProgress).toHaveLength(19);
    const rows = db.select().from(sources).all();
    expect(rows).toHaveLength(1);
  });

  it('cooldown returns too_recent after a confirmed source within cooldown window', async () => {
    const tenSecAgo = Date.now() - 10_000;
    db.insert(sources)
      .values({
        kind: 'external',
        normalizedUrl: 'https://github.com/o/r',
        originalUrl: 'https://github.com/o/r',
        origin: 'github_refresh',
        status: 'confirmed',
        createdAt: tenSecAgo,
        updatedAt: tenSecAgo,
      })
      .run();
    const result = await service.refreshRepoByNormalizedUrl('https://github.com/o/r');
    expect(result.status).toBe('too_recent');
    if (result.status === 'too_recent') {
      expect(result.lastRefreshedAt).toBe(tenSecAgo);
    }
  });

  it('terminal failure short-circuits cooldown and returns not_found', async () => {
    const recent = new Date(Date.now() - 5_000).toISOString();
    db.insert(sources)
      .values({
        kind: 'external',
        normalizedUrl: 'https://github.com/o/r',
        originalUrl: 'https://github.com/o/r',
        origin: 'github_refresh',
        status: 'failed',
        metadata: JSON.stringify({ collector_failure_code: 'not_found' }),
        createdAt: recent,
        updatedAt: recent,
      })
      .run();
    const result = await service.refreshRepoByNormalizedUrl('https://github.com/o/r');
    expect(result.status).toBe('not_found');
  });

  it('stale not_found record beyond cooldown does NOT permanently poison — allows retry', async () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    db.insert(sources)
      .values({
        kind: 'external',
        normalizedUrl: 'https://github.com/o/r',
        originalUrl: 'https://github.com/o/r',
        origin: 'github_refresh',
        status: 'failed',
        metadata: JSON.stringify({ collector_failure_code: 'not_found' }),
        createdAt: stale,
        updatedAt: stale,
      })
      .run();
    const result = await service.refreshRepoByNormalizedUrl('https://github.com/o/r');
    expect(result.status).toBe('started');
  });

  it('archived repo returns archived status', async () => {
    const stamp = new Date().toISOString();
    db.insert(sources)
      .values({
        kind: 'external',
        normalizedUrl: 'https://github.com/o/r',
        originalUrl: 'https://github.com/o/r',
        origin: 'user',
        status: 'confirmed',
        metadata: JSON.stringify({
          collector_github_archived: true,
          collector_github_archived_at: stamp,
        }),
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
    const result = await service.refreshRepoByNormalizedUrl('https://github.com/o/r');
    expect(result.status).toBe('archived');
    if (result.status === 'archived') {
      expect(result.archivedAt).toBe(Date.parse(stamp));
    }
  });
});

describe('GithubService.summarizeLatestGithubSource', () => {
  let db: DrizzleDB;
  let cleanup: () => void;
  let service: GithubService;

  beforeEach(() => {
    const h = createTestDB();
    db = h.db;
    cleanup = h.cleanup;
    service = new GithubService({ db, cooldownSec: 60 });
  });
  afterEach(() => cleanup());

  it('returns null when no rows are github-collector sources', () => {
    const rows = [
      { metadata: null, normalizedUrl: 'https://example.com', createdAt: '1', updatedAt: '1' },
      {
        metadata: JSON.stringify({ collectorPlugin: 'collector-web' }),
        normalizedUrl: 'https://example.com',
        createdAt: '2',
        updatedAt: '2',
      },
    ];
    expect(service.summarizeLatestGithubSource(rows)).toBeNull();
  });

  it('picks the latest github-collector row and extracts owner/repo/archived', () => {
    const olderMs = Date.parse('2024-01-01T00:00:00.000Z');
    const newerMs = Date.parse('2024-02-01T00:00:00.000Z');
    const older = {
      metadata: JSON.stringify({
        collectorPlugin: 'collector-github',
        collector_github_owner: 'o1',
        collector_github_repo: 'r1',
      }),
      normalizedUrl: 'https://github.com/o1/r1',
      createdAt: olderMs,
      updatedAt: olderMs,
    };
    const newer = {
      metadata: JSON.stringify({
        collectorPlugin: 'collector-github',
        collector_github_owner: 'o2',
        collector_github_repo: 'r2',
        collector_github_archived: true,
      }),
      normalizedUrl: 'https://github.com/o2/r2',
      createdAt: newerMs,
      updatedAt: newerMs,
    };
    const summary = service.summarizeLatestGithubSource([older, newer]);
    expect(summary).toEqual({
      owner: 'o2',
      repo: 'r2',
      normalizedUrl: 'https://github.com/o2/r2',
      archived: true,
      lastRefreshedAt: newerMs,
    });
  });

  it('tolerates invalid JSON in metadata', () => {
    const rows = [
      {
        metadata: '{not valid json',
        normalizedUrl: 'https://github.com/o/r',
        createdAt: '1',
        updatedAt: '1',
      },
    ];
    expect(service.summarizeLatestGithubSource(rows)).toBeNull();
  });
});
