import { describe, expect, it } from 'vitest';
import { nextTheme } from './theme-cycle';

describe('nextTheme', () => {
  it('system → light', () => {
    expect(nextTheme('system')).toBe('light');
  });

  it('light → dark', () => {
    expect(nextTheme('light')).toBe('dark');
  });

  it('dark → system', () => {
    expect(nextTheme('dark')).toBe('system');
  });
});
