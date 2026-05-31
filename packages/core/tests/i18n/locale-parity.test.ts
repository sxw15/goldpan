import { describe, expect, it } from 'vitest';
import en from '../../src/i18n/locales/en.json';
import zh from '../../src/i18n/locales/zh.json';

function getLeafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null) {
      keys.push(...getLeafKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

describe('core locale key parity', () => {
  const enKeys = new Set(getLeafKeys(en));
  const zhKeys = new Set(getLeafKeys(zh));

  it('en.json and zh.json have identical keys', () => {
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
    expect(missingInZh, `Keys missing in zh.json: ${missingInZh.join(', ')}`).toEqual([]);
    expect(missingInEn, `Keys missing in en.json: ${missingInEn.join(', ')}`).toEqual([]);
  });

  it('en.json and zh.json have matching placeholders per key', () => {
    function getLeafEntries(obj: Record<string, unknown>, prefix = ''): [string, string][] {
      const entries: [string, string][] = [];
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'object' && value !== null) {
          entries.push(...getLeafEntries(value as Record<string, unknown>, fullKey));
        } else if (typeof value === 'string') {
          entries.push([fullKey, value]);
        }
      }
      return entries;
    }

    function extractPlaceholders(value: string): string[] {
      const matches = value.match(/\{(\w+)\}/g);
      return matches ? matches.sort() : [];
    }

    const enEntries = getLeafEntries(en);
    const zhMap = new Map(getLeafEntries(zh));
    const mismatches: string[] = [];

    for (const [key, enValue] of enEntries) {
      const zhValue = zhMap.get(key);
      if (zhValue) {
        const enVars = extractPlaceholders(enValue);
        const zhVars = extractPlaceholders(zhValue);
        if (JSON.stringify(enVars) !== JSON.stringify(zhVars)) {
          mismatches.push(`${key}: en=${enVars.join(',')} zh=${zhVars.join(',')}`);
        }
      }
    }

    expect(mismatches, `Placeholder mismatches:\n${mismatches.join('\n')}`).toEqual([]);
  });
});
