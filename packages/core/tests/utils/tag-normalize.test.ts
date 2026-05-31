import { describe, expect, it } from 'vitest';
import { normalizeTags } from '../../src/utils/tag-normalize';

describe('normalizeTags', () => {
  it('returns [] for undefined or empty input', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags([])).toEqual([]);
  });

  it('trims surrounding whitespace and drops empty entries', () => {
    expect(normalizeTags(['  趋势判断  ', '', '   ', '短期'])).toEqual(['趋势判断', '短期']);
  });

  it('case-folds duplicates while keeping the first-seen casing', () => {
    expect(normalizeTags(['React', 'react', 'REACT'])).toEqual(['React']);
  });

  it('preserves order of first occurrences', () => {
    expect(normalizeTags(['趋势判断', '短期', '趋势判断', '产品节奏'])).toEqual([
      '趋势判断',
      '短期',
      '产品节奏',
    ]);
  });

  it('treats a tag that becomes empty after trim as dropped', () => {
    expect(normalizeTags(['  ', '\t\t', '\n'])).toEqual([]);
  });
});
