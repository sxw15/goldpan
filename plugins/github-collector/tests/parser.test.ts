import { describe, expect, it } from 'vitest';
import { buildNormalizedUrl, parseOwnerRepo } from '../src/parser.js';

describe('parseOwnerRepo', () => {
  it('extracts owner/repo and lowercases them', () => {
    expect(parseOwnerRepo('https://github.com/Facebook/React')).toEqual({
      owner: 'facebook',
      repo: 'react',
      normalizedUrl: 'https://github.com/facebook/react',
      subPath: undefined,
    });
  });

  it('captures subPath but excludes it from normalizedUrl', () => {
    expect(parseOwnerRepo('https://github.com/vercel/next.js/tree/canary/packages')).toEqual({
      owner: 'vercel',
      repo: 'next.js',
      normalizedUrl: 'https://github.com/vercel/next.js',
      subPath: 'tree/canary/packages',
    });
  });

  it('throws when path is missing a repo segment', () => {
    expect(() => parseOwnerRepo('https://github.com/facebook')).toThrow();
  });

  it('strips trailing .git from repo name', () => {
    expect(parseOwnerRepo('https://github.com/facebook/react.git')).toEqual({
      owner: 'facebook',
      repo: 'react',
      normalizedUrl: 'https://github.com/facebook/react',
      subPath: undefined,
    });
  });

  it('collapses /owner/repo and /owner/repo.git to the same normalizedUrl', () => {
    const a = parseOwnerRepo('https://github.com/Facebook/React.git');
    const b = parseOwnerRepo('https://github.com/facebook/react');
    expect(a.normalizedUrl).toBe(b.normalizedUrl);
  });
});

describe('buildNormalizedUrl', () => {
  it('lowercases owner + repo and returns canonical URL', () => {
    expect(buildNormalizedUrl('Facebook', 'React')).toBe('https://github.com/facebook/react');
  });

  it('strips trailing .git (case-insensitive)', () => {
    expect(buildNormalizedUrl('facebook', 'react.git')).toBe('https://github.com/facebook/react');
    expect(buildNormalizedUrl('facebook', 'React.GIT')).toBe('https://github.com/facebook/react');
  });
});
