import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { classify } from '../src/stderr-classifier';

const samplesDir = join(import.meta.dirname, 'fixtures', 'stderr-samples');
const read = (name: string) => readFileSync(join(samplesDir, name), 'utf-8');

describe('classify (stderr, exitCode)', () => {
  it('returns null when exitCode is 0 (success not classified)', () => {
    expect(classify('any progress text', 0)).toBeNull();
  });

  it('classifies private video as NOT_FOUND non-retryable', () => {
    expect(classify(read('private-video.txt'), 1)).toEqual({
      code: 'NOT_FOUND',
      retryable: false,
    });
  });

  it('classifies video unavailable as NOT_FOUND', () => {
    expect(classify(read('video-unavailable.txt'), 1)).toEqual({
      code: 'NOT_FOUND',
      retryable: false,
    });
  });

  it('classifies geo block as INVALID_REQUEST', () => {
    expect(classify(read('geo-blocked.txt'), 1)).toEqual({
      code: 'INVALID_REQUEST',
      retryable: false,
    });
  });

  it('classifies HTTP 429 as RATE_LIMIT retryable', () => {
    expect(classify(read('rate-limit.txt'), 1)).toEqual({
      code: 'RATE_LIMIT',
      retryable: true,
    });
  });

  it('classifies HTTP 5xx as UPSTREAM retryable', () => {
    expect(classify(read('upstream-5xx.txt'), 1)).toEqual({
      code: 'UPSTREAM',
      retryable: true,
    });
  });

  it('classifies login required as INVALID_REQUEST', () => {
    expect(classify(read('login-required.txt'), 1)).toEqual({
      code: 'INVALID_REQUEST',
      retryable: false,
    });
  });

  it('classifies connection refused as FETCH_FAILED retryable', () => {
    expect(classify(read('network-fail.txt'), 1)).toEqual({
      code: 'FETCH_FAILED',
      retryable: true,
    });
  });

  it('falls back to FETCH_FAILED non-retryable for unknown stderr (avoids retry-storm on un-classified failure)', () => {
    expect(classify('ERROR: unknown reason', 1)).toEqual({
      code: 'FETCH_FAILED',
      retryable: false,
    });
  });

  it('logs the un-classified stderr so the classifier can be extended', () => {
    const warn = vi.fn();
    classify('ERROR: brand new yt-dlp signature failure', 1, { logger: { warn } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown yt-dlp stderr'));
  });
});
