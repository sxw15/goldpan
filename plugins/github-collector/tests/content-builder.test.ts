import { describe, expect, it } from 'vitest';
import { buildInitialContent } from '../src/content-builder.js';

describe('buildInitialContent', () => {
  it('assembles [Repo Meta] + [README] + [Releases] + [Commits] sections', () => {
    const out = buildInitialContent({
      repoMeta: {
        full_name: 'facebook/react',
        description: 'A JavaScript library',
        default_branch: 'main',
        language: 'JavaScript',
        stargazers_count: 200000,
        forks_count: 40000,
        license: { spdx_id: 'MIT' },
        topics: ['ui'],
        archived: false,
        fork: false,
        created_at: '2013-05-24T16:15:54Z',
        pushed_at: '2026-04-15T00:00:00Z',
      },
      readme: '# React\n\nUI library.',
      releases: [{ tag_name: 'v18.3.0', published_at: '2026-04-15T00:00:00Z', body: 'bugfix' }],
      commits: [
        {
          sha: 'abc1234',
          commit: { message: 'fix: bug', author: { date: '2026-04-17', name: 'alice' } },
        },
      ],
      changelog: null,
      cleanReadme: true,
      maxContentLength: 200_000,
    });
    expect(out.content).toContain('[Repo Meta]');
    expect(out.content).toContain('facebook/react');
    expect(out.content).toContain('[README]');
    expect(out.content).toContain('UI library');
    expect(out.content).toContain('[Recent Releases');
    expect(out.content).toContain('v18.3.0');
    expect(out.content).toContain('[Recent Commits');
    expect(out.content).toContain('abc1234');
    expect(out.watermarks.lastCommitSha).toBe('abc1234');
    expect(out.watermarks.lastReleaseTag).toBe('v18.3.0');
    expect(out.watermarks.readmeHash).toMatch(/^sha256:/);
  });

  it('truncates README longer than maxContentLength', () => {
    const huge = 'x'.repeat(500_000);
    const out = buildInitialContent({
      repoMeta: { full_name: 'o/r', default_branch: 'main' },
      readme: huge,
      releases: [],
      commits: [],
      changelog: null,
      cleanReadme: false,
      maxContentLength: 200_000,
    });
    expect(out.readmeSentSize).toBe(200_000);
    expect(out.readmeTruncated).toBe(true);
  });

  // Regression for truncation unit mismatch: .slice used UTF-16 code units
  // against a UTF-8 byte budget, so a CJK README of 30k chars (≈90k bytes)
  // would have been sliced at 30000 code units and stay 90k bytes — triple
  // the intended cap. The fix truncates at byte boundaries.
  it('truncates CJK README by bytes, not code units', () => {
    // '中' is 3 bytes UTF-8, 1 code unit UTF-16.
    const cjk = '中'.repeat(100_000); // 300k bytes, 100k code units.
    const out = buildInitialContent({
      repoMeta: { full_name: 'o/r', default_branch: 'main' },
      readme: cjk,
      releases: [],
      commits: [],
      changelog: null,
      cleanReadme: false,
      maxContentLength: 30_000,
    });
    expect(out.readmeTruncated).toBe(true);
    // With byte-correct truncation the sent size is ≤ the cap. With the
    // old code-unit slice it would have been ≈ 90_000.
    expect(out.readmeSentSize).toBeLessThanOrEqual(30_000);
  });
});
