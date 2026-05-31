export function redactSecret(value: string): string {
  if (value.length === 0) return '';
  if (value.length <= 6) return '••••••';
  return `${value.slice(0, 3)}••••••${value.slice(-3)}`;
}
