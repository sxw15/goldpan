import { describe, expect, it } from 'vitest';
import { parseFocusId, parseInspectorKind, safeHref } from './url';

describe('parseFocusId', () => {
  it('returns null for undefined', () => {
    expect(parseFocusId(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseFocusId(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseFocusId('')).toBeNull();
  });

  it('returns null for non-numeric', () => {
    expect(parseFocusId('abc')).toBeNull();
  });

  it('returns null for negative', () => {
    expect(parseFocusId('-1')).toBeNull();
  });

  it('returns null for zero', () => {
    expect(parseFocusId('0')).toBeNull();
  });

  it('returns null for fractional', () => {
    expect(parseFocusId('1.5')).toBeNull();
  });

  it('returns null for scientific notation', () => {
    expect(parseFocusId('1e3')).toBeNull();
  });

  it('returns null for hex literal', () => {
    expect(parseFocusId('0x10')).toBeNull();
  });

  it('returns null for explicit plus sign', () => {
    expect(parseFocusId('+7')).toBeNull();
  });

  it('returns null for strings with whitespace', () => {
    expect(parseFocusId(' 42')).toBeNull();
    expect(parseFocusId('42 ')).toBeNull();
    expect(parseFocusId(' 42 ')).toBeNull();
  });

  it('returns null for leading zeros', () => {
    expect(parseFocusId('042')).toBeNull();
  });

  it('returns integer for valid positive number string', () => {
    expect(parseFocusId('42')).toBe(42);
  });
});

describe('safeHref', () => {
  it('returns url for http/https', () => {
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
    expect(safeHref('HTTPS://EXAMPLE.COM')).toBe('HTTPS://EXAMPLE.COM');
  });

  it('returns # for non-http(s) schemes', () => {
    expect(safeHref('javascript:alert(1)')).toBe('#');
    expect(safeHref('data:text/html,<script>')).toBe('#');
    expect(safeHref('ftp://example.com')).toBe('#');
  });

  it('returns # for empty / null / undefined', () => {
    expect(safeHref('')).toBe('#');
    expect(safeHref(null)).toBe('#');
    expect(safeHref(undefined)).toBe('#');
  });
});

describe('parseInspectorKind', () => {
  it('returns raw when in allowed list', () => {
    expect(parseInspectorKind('entity', ['entity', 'source'] as const, 'entity')).toBe('entity');
    expect(parseInspectorKind('source', ['entity', 'source'] as const, 'entity')).toBe('source');
  });

  it('returns fallback when raw not in allowed list', () => {
    expect(parseInspectorKind('bogus', ['entity', 'source'] as const, 'entity')).toBe('entity');
    expect(parseInspectorKind('note', ['entity', 'source'] as const, 'entity')).toBe('entity');
  });

  it('returns fallback when raw is null/undefined/empty', () => {
    expect(parseInspectorKind(null, ['entity', 'source'] as const, 'entity')).toBe('entity');
    expect(parseInspectorKind(undefined, ['entity', 'source'] as const, 'entity')).toBe('entity');
    expect(parseInspectorKind('', ['entity', 'source'] as const, 'entity')).toBe('entity');
  });
});
