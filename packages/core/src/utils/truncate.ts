export function truncate(s: string, max: number, ellipsis = '…'): string {
  return s.length > max ? `${s.slice(0, max)}${ellipsis}` : s;
}
