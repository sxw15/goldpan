import { describe, expect, test } from 'vitest';
import { sanitizeErrorMessage } from './sanitize-error';

describe('sanitizeErrorMessage', () => {
  test('strips full URLs from message', () => {
    const err = new Error('fetch failed at http://internal.lan:8443/api/commit');
    expect(sanitizeErrorMessage(err)).toBe('fetch failed at <url>');
  });

  test('strips https URLs from message', () => {
    const err = new Error('cert invalid for https://10.0.0.5:8080/path?token=abc');
    expect(sanitizeErrorMessage(err)).toBe('cert invalid for <url>');
  });

  test('strips bare IPv4 + port', () => {
    const err = new Error('ECONNREFUSED 192.168.1.10:8443');
    expect(sanitizeErrorMessage(err)).toBe('ECONNREFUSED <host>');
  });

  test('strips bare IPv4 without port', () => {
    const err = new Error('cert mismatch on 10.0.0.5');
    expect(sanitizeErrorMessage(err)).toBe('cert mismatch on <host>');
  });

  test('keeps the message intact when no URL / IP', () => {
    const err = new Error('value must be at least 8 characters');
    expect(sanitizeErrorMessage(err)).toBe('value must be at least 8 characters');
  });

  test('drops stack trace, keeps first line', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at foo (/secret/path.ts:12:5)\n    at bar (/x.ts:9:3)';
    // Note: Error.message is `boom`; stack lives on .stack and is NOT
    // included by sanitizeErrorMessage's input — but if a caller passes a
    // String(stack) shape we still drop everything after the first \n.
    expect(sanitizeErrorMessage(err.stack)).toBe('Error: boom');
  });

  test('caps long messages at 200 chars with ellipsis', () => {
    const long = 'x'.repeat(300);
    const out = sanitizeErrorMessage(long);
    expect(out.length).toBe(201);
    expect(out.endsWith('…')).toBe(true);
  });

  test('non-Error input falls back to String()', () => {
    expect(sanitizeErrorMessage(42)).toBe('42');
    expect(sanitizeErrorMessage({ toString: () => 'ECONNREFUSED 127.0.0.1' })).toBe(
      'ECONNREFUSED <host>',
    );
  });

  test('does not over-match version-like dotted numbers (false positive shape)', () => {
    // Real-world false-positive risk: "v1.2.3" or "node 22.4.0" look like
    // IPv4 but aren't. Current implementation will NOT strip these because
    // \b boundary + four-octet pattern won't match three components.
    const err = new Error('node 22.4.0 detected');
    expect(sanitizeErrorMessage(err)).toBe('node 22.4.0 detected');
  });
});
