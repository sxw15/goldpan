import { describe, expect, it } from 'vitest';
import { mintShareUrl, verifyShareSig } from './sign.js';

const KEY = 'a'.repeat(32);
const NOW = 1_716_000_000_000;
const BASE = 'https://digest.example.com';

function extractSig(url: string): string {
  return new URL(url).searchParams.get('sig')!;
}

describe('mintShareUrl', () => {
  it('returns a URL with /digest/share/<id>?sig=<payload>.<sig>', () => {
    const url = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: BASE,
      nowMs: NOW,
    });
    expect(url.startsWith(`${BASE}/digest/share/42?sig=`)).toBe(true);
    const sig = extractSig(url);
    expect(sig.split('.').length).toBe(2);
  });
});

describe('verifyShareSig', () => {
  it('verifies a freshly minted token', () => {
    const url = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: BASE,
      nowMs: NOW,
    });
    const result = verifyShareSig({
      digestId: 42,
      sigParam: extractSig(url),
      signingKey: KEY,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('round-trips an optional render preset id', () => {
    const url = mintShareUrl({
      digestId: 42,
      presetId: 7,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: BASE,
      nowMs: NOW,
    });
    const result = verifyShareSig({
      digestId: 42,
      sigParam: extractSig(url),
      signingKey: KEY,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.pid).toBe(7);
  });

  it('rejects tampered payload (different did encoded)', () => {
    const url = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: BASE,
      nowMs: NOW,
    });
    const sig = extractSig(url);
    const [_payload, sigPart] = sig.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, did: 99, exp: Math.floor(NOW / 1000) + 86400 }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = verifyShareSig({
      digestId: 99,
      sigParam: `${forgedPayload}.${sigPart}`,
      signingKey: KEY,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tampered');
  });

  it('rejects mismatched did (token for 42 used at /share/99)', () => {
    const url = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: BASE,
      nowMs: NOW,
    });
    const result = verifyShareSig({
      digestId: 99,
      sigParam: extractSig(url),
      signingKey: KEY,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('rejects expired token', () => {
    const url = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 1,
      publicBaseUrl: BASE,
      nowMs: NOW,
    });
    const future = NOW + 2 * 86400 * 1000;
    const result = verifyShareSig({
      digestId: 42,
      sigParam: extractSig(url),
      signingKey: KEY,
      nowMs: future,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects malformed sig (no dot separator)', () => {
    const result = verifyShareSig({
      digestId: 42,
      sigParam: 'no-dot-here',
      signingKey: KEY,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('rejects malformed sig (non-base64url junk in payload)', () => {
    const result = verifyShareSig({
      digestId: 42,
      sigParam: '!!!.???',
      signingKey: KEY,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('rejects when signingKey differs', () => {
    const url = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: BASE,
      nowMs: NOW,
    });
    const result = verifyShareSig({
      digestId: 42,
      sigParam: extractSig(url),
      signingKey: 'b'.repeat(32),
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tampered');
  });

  it('rejects payload with wrong version', () => {
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 2, did: 42, exp: Math.floor(NOW / 1000) + 86400 }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = verifyShareSig({
      digestId: 42,
      sigParam: `${forgedPayload}.x`,
      signingKey: KEY,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('rejects mismatched-length sig bytes (timingSafeEqual length guard)', () => {
    const url = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: BASE,
      nowMs: NOW,
    });
    const [payload] = extractSig(url).split('.');
    const result = verifyShareSig({
      digestId: 42,
      sigParam: `${payload}.aGVsbG8`,
      signingKey: KEY,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tampered');
  });
});

describe('mintShareUrl signingKey length guard', () => {
  it('throws when signingKey is empty', () => {
    expect(() =>
      mintShareUrl({
        digestId: 42,
        signingKey: '',
        ttlDays: 14,
        publicBaseUrl: BASE,
        nowMs: NOW,
      }),
    ).toThrow(/at least 32 chars/);
  });

  it('throws when signingKey is shorter than 32 chars', () => {
    expect(() =>
      mintShareUrl({
        digestId: 42,
        signingKey: 'a'.repeat(31),
        ttlDays: 14,
        publicBaseUrl: BASE,
        nowMs: NOW,
      }),
    ).toThrow(/at least 32 chars/);
  });

  it('accepts signingKey of exactly 32 chars (boundary)', () => {
    expect(() =>
      mintShareUrl({
        digestId: 42,
        signingKey: 'a'.repeat(32),
        ttlDays: 14,
        publicBaseUrl: BASE,
        nowMs: NOW,
      }),
    ).not.toThrow();
  });
});

describe('mintShareUrl publicBaseUrl normalization', () => {
  it('strips a single trailing slash so output never contains "//digest/share/"', () => {
    const url = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: 'https://digest.example.com/',
      nowMs: NOW,
    });
    expect(url).not.toContain('//digest/share');
    expect(url.startsWith('https://digest.example.com/digest/share/42?sig=')).toBe(true);
  });

  it('strips multiple trailing slashes', () => {
    const url = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: 'https://digest.example.com///',
      nowMs: NOW,
    });
    expect(url.startsWith('https://digest.example.com/digest/share/42?sig=')).toBe(true);
  });

  it('produces identical sig param whether trailing slash is present or absent (sig depends on payload only)', () => {
    const a = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: 'https://digest.example.com',
      nowMs: NOW,
    });
    const b = mintShareUrl({
      digestId: 42,
      signingKey: KEY,
      ttlDays: 14,
      publicBaseUrl: 'https://digest.example.com/',
      nowMs: NOW,
    });
    expect(extractSig(a)).toBe(extractSig(b));
  });
});
