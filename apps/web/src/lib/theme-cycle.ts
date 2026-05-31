export type Theme = 'system' | 'light' | 'dark';

export function nextTheme(current: Theme): Theme {
  if (current === 'system') return 'light';
  if (current === 'light') return 'dark';
  return 'system';
}
