import { describe, expect, it } from 'vitest';
import { findSupportedSite, isSupportedUrl, SUPPORTED_SITES } from '../src/supported-sites';

describe('SUPPORTED_SITES', () => {
  it('contains YouTube, Bilibili, Vimeo', () => {
    const names = SUPPORTED_SITES.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['YouTube', 'Bilibili', 'Vimeo']));
  });
});

describe('findSupportedSite', () => {
  it('matches exact host', () => {
    expect(findSupportedSite('youtube.com')?.name).toBe('YouTube');
    expect(findSupportedSite('bilibili.com')?.name).toBe('Bilibili');
    expect(findSupportedSite('vimeo.com')?.name).toBe('Vimeo');
  });

  it('matches subdomain via dot prefix', () => {
    expect(findSupportedSite('m.youtube.com')?.name).toBe('YouTube');
    expect(findSupportedSite('music.youtube.com')?.name).toBe('YouTube');
    expect(findSupportedSite('player.vimeo.com')?.name).toBe('Vimeo');
  });

  it('rejects forged domain', () => {
    expect(findSupportedSite('fake-youtube.com')).toBeUndefined();
    expect(findSupportedSite('youtube.com.evil.tld')).toBeUndefined();
  });

  it('is case insensitive on host', () => {
    expect(findSupportedSite('YouTube.com')?.name).toBe('YouTube');
  });

  it('rejects empty / unknown host', () => {
    expect(findSupportedSite('')).toBeUndefined();
    expect(findSupportedSite('example.com')).toBeUndefined();
  });
});

describe('isSupportedUrl', () => {
  it('accepts http and https video URLs in whitelist', () => {
    expect(isSupportedUrl('https://www.youtube.com/watch?v=xxx')).toBe(true);
    expect(isSupportedUrl('http://m.bilibili.com/video/BV1xxx')).toBe(true);
    expect(isSupportedUrl('https://b23.tv/abc')).toBe(true);
  });

  it('rejects non-http protocol', () => {
    expect(isSupportedUrl('ftp://youtube.com/x')).toBe(false);
  });

  it('rejects malformed URL', () => {
    expect(isSupportedUrl('not a url')).toBe(false);
  });

  it('rejects URL outside whitelist', () => {
    expect(isSupportedUrl('https://example.com/video')).toBe(false);
  });
});
