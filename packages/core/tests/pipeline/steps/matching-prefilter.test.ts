import { describe, expect, it } from 'vitest';
import { shouldPrefilter } from '../../../src/pipeline/steps/matching-prefilter.js';

describe('shouldPrefilter', () => {
  const mockProvider = {
    embedMany: async () => [],
    embed: async () => [],
    dimensions: 384,
    modelId: 'test',
  };
  const mockDb = {} as any;

  it('returns false when embeddingProvider is null', () => {
    expect(shouldPrefilter(null, mockDb, 50)).toBe(false);
  });

  it('returns false when embeddingProvider is undefined', () => {
    expect(shouldPrefilter(undefined, mockDb, 50)).toBe(false);
  });

  it('returns false when db is undefined', () => {
    expect(shouldPrefilter(mockProvider, undefined, 50)).toBe(false);
  });

  it('returns false when entity count is at threshold', () => {
    expect(shouldPrefilter(mockProvider, mockDb, 30)).toBe(false);
  });

  it('returns false when entity count is below threshold', () => {
    expect(shouldPrefilter(mockProvider, mockDb, 10)).toBe(false);
  });

  it('returns true when all conditions met', () => {
    expect(shouldPrefilter(mockProvider, mockDb, 31)).toBe(true);
  });
});
