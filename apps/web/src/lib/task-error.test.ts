import { describe, expect, test } from 'vitest';
import en from '../../messages/en.json';
import zh from '../../messages/zh.json';
import { KNOWN_ERROR_KINDS, localizeErrorKind, normalizeErrorKind } from './task-error';

describe('normalizeErrorKind', () => {
  test('known kinds pass through unchanged', () => {
    expect(normalizeErrorKind('content_policy')).toBe('content_policy');
    expect(normalizeErrorKind('content_length')).toBe('content_length');
    expect(normalizeErrorKind('schema_validation')).toBe('schema_validation');
    expect(normalizeErrorKind('rate_limit')).toBe('rate_limit');
    expect(normalizeErrorKind('timeout')).toBe('timeout');
    expect(normalizeErrorKind('unknown')).toBe('unknown');
  });

  test('unrecognized / null / undefined / empty fall back to "unknown"', () => {
    expect(normalizeErrorKind('some_future_kind')).toBe('unknown');
    expect(normalizeErrorKind(null)).toBe('unknown');
    expect(normalizeErrorKind(undefined)).toBe('unknown');
    expect(normalizeErrorKind('')).toBe('unknown');
  });
});

describe('localizeErrorKind', () => {
  // The translator is `task_detail`-scoped at call sites; here we stub it to
  // echo the key so we can assert which i18n key each kind resolves to.
  const t = (key: string) => `T:${key}`;

  test('maps a known kind to error_kind_<kind>', () => {
    expect(localizeErrorKind('content_policy', t)).toBe('T:error_kind_content_policy');
    expect(localizeErrorKind('content_length', t)).toBe('T:error_kind_content_length');
    expect(localizeErrorKind('rate_limit', t)).toBe('T:error_kind_rate_limit');
  });

  test('unrecognized / null kinds localize as error_kind_unknown', () => {
    expect(localizeErrorKind('weird', t)).toBe('T:error_kind_unknown');
    expect(localizeErrorKind(null, t)).toBe('T:error_kind_unknown');
    expect(localizeErrorKind(undefined, t)).toBe('T:error_kind_unknown');
  });
});

// Pairs with web-sdk/tests/task-error-kinds-sync.test.ts (kinds ↔ core): that
// guards the list, this guards the messages. Together a new core error kind
// can't ship without both a web-sdk mirror entry AND a localized message.
describe('error_kind i18n coverage', () => {
  // task_detail has nested objects (pipeline_step), so cast through unknown;
  // we only read the flat error_kind_* string values.
  const zhKinds = zh.task_detail as unknown as Record<string, string>;
  const enKinds = en.task_detail as unknown as Record<string, string>;
  for (const kind of KNOWN_ERROR_KINDS) {
    test(`error_kind_${kind} has a zh + en message`, () => {
      expect(zhKinds[`error_kind_${kind}`]).toBeTruthy();
      expect(enKinds[`error_kind_${kind}`]).toBeTruthy();
    });
  }
});
