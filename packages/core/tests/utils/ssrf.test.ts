import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPrivateIp, validateSsrf, validateSsrfIfEnabled } from '../../src/utils/ssrf.js';

describe('isPrivateIp', () => {
  it('detects IPv4 loopback', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.255.255.255')).toBe(true);
  });

  it('detects IPv4 private ranges', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('detects CGNAT range (RFC 6598)', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.127.255.254')).toBe(true);
  });

  it('detects IPv4 link-local', () => {
    expect(isPrivateIp('169.254.1.1')).toBe(true);
  });

  it('detects broadcast', () => {
    expect(isPrivateIp('255.255.255.255')).toBe(true);
  });

  it('detects multicast', () => {
    expect(isPrivateIp('224.0.0.1')).toBe(true);
  });

  it('detects reserved ranges', () => {
    expect(isPrivateIp('192.0.2.1')).toBe(true); // TEST-NET-1
    expect(isPrivateIp('198.51.100.1')).toBe(true); // TEST-NET-2
    expect(isPrivateIp('203.0.113.1')).toBe(true); // TEST-NET-3
    expect(isPrivateIp('198.18.0.1')).toBe(true); // benchmark
    expect(isPrivateIp('240.0.0.1')).toBe(true); // future use
  });

  it('allows public IPv4', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('151.101.1.69')).toBe(false);
  });

  it('detects IPv6 loopback', () => {
    expect(isPrivateIp('::1')).toBe(true);
  });

  it('detects IPv6 link-local', () => {
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('detects IPv6 multicast', () => {
    expect(isPrivateIp('ff02::1')).toBe(true);
  });

  it('detects IPv6 teredo', () => {
    expect(isPrivateIp('2001::1')).toBe(true);
  });

  it('detects IPv6 6to4', () => {
    expect(isPrivateIp('2002::1')).toBe(true);
  });

  it('detects IPv6 discard', () => {
    expect(isPrivateIp('100::1')).toBe(true);
  });

  it('detects IPv4-mapped IPv6', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
  });

  it('allows public IPv6', () => {
    expect(isPrivateIp('2606:4700::1')).toBe(false);
  });

  it('detects IPv4 unspecified (0.0.0.0/8)', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('detects IETF protocol range (192.0.0.0/24)', () => {
    expect(isPrivateIp('192.0.0.1')).toBe(true);
  });

  it('detects IPv6 unspecified (::)', () => {
    expect(isPrivateIp('::')).toBe(true);
  });

  it('detects IPv6 ULA (fc00::/7)', () => {
    expect(isPrivateIp('fd00::1')).toBe(true);
  });

  it('rejects non-standard IP encoding', () => {
    expect(() => isPrivateIp('0x7f.0.0.1')).toThrow(/Non-standard/);
    expect(() => isPrivateIp('0177.0.0.1')).toThrow(/Non-standard/);
  });

  it('rejects integer IP format', () => {
    expect(() => isPrivateIp('2130706433')).toThrow(/Non-standard/);
  });
});

describe('validateSsrf', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-HTTP protocols', async () => {
    await expect(validateSsrf('ftp://example.com')).rejects.toThrow(/Protocol/);
  });

  it('rejects URL with private IP hostname', async () => {
    await expect(validateSsrf('https://127.0.0.1/api')).rejects.toThrow(/private|reserved/i);
    await expect(validateSsrf('https://192.168.1.1/api')).rejects.toThrow(/private|reserved/i);
  });

  it('rejects URL resolving to private IP', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['127.0.0.1']);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(
      Object.assign(new Error('no AAAA'), { code: 'ENODATA' }),
    );
    await expect(validateSsrf('https://evil.example.com/api')).rejects.toThrow(/private|reserved/i);
  });

  it('accepts URL resolving to public IP', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['151.101.1.69']);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(
      Object.assign(new Error('no AAAA'), { code: 'ENODATA' }),
    );
    await expect(validateSsrf('https://public.example.com/api')).resolves.toBeUndefined();
  });

  it('rejects when DNS resolution fails entirely', async () => {
    const dns = await import('node:dns');
    const noRecord = Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' });
    vi.spyOn(dns.promises, 'resolve4').mockRejectedValue(noRecord);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(noRecord);
    await expect(validateSsrf('https://nonexistent.example.com')).rejects.toThrow(
      /DNS resolution failed/,
    );
  });

  it('checks all resolved IPs (mixed public/private rejects)', async () => {
    const dns = await import('node:dns');
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['8.8.8.8', '127.0.0.1']);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(
      Object.assign(new Error('no AAAA'), { code: 'ENODATA' }),
    );
    await expect(validateSsrf('https://mixed.example.com')).rejects.toThrow(/private|reserved/i);
  });

  it('accepts when one family resolves public despite non-no-record error on the other', async () => {
    const dns = await import('node:dns');
    const servfail = Object.assign(new Error('queryA SERVFAIL'), { code: 'SERVFAIL' });
    vi.spyOn(dns.promises, 'resolve4').mockRejectedValue(servfail);
    vi.spyOn(dns.promises, 'resolve6').mockResolvedValue(['2606:4700::1']);
    await expect(validateSsrf('https://flaky-dns.example.com')).resolves.toBeUndefined();
  });

  it('rejects when both families fail with non-no-record DNS errors', async () => {
    const dns = await import('node:dns');
    const servfail4 = Object.assign(new Error('queryA SERVFAIL'), { code: 'SERVFAIL' });
    const servfail6 = Object.assign(new Error('queryAAAA SERVFAIL'), { code: 'SERVFAIL' });
    vi.spyOn(dns.promises, 'resolve4').mockRejectedValue(servfail4);
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(servfail6);
    await expect(validateSsrf('https://broken-dns.example.com')).rejects.toThrow(
      /DNS resolution error/,
    );
  });

  it('rejects hex-encoded private IP (pre-parse check)', async () => {
    await expect(validateSsrf('https://0x7f.0.0.1/api')).rejects.toThrow(
      /Non-standard IP encoding/i,
    );
  });

  it('rejects octal-encoded private IP (pre-parse check)', async () => {
    await expect(validateSsrf('https://0177.0.0.1/api')).rejects.toThrow(
      /Non-standard IP encoding/i,
    );
  });

  it('rejects integer-encoded private IP (pre-parse check)', async () => {
    await expect(validateSsrf('https://2130706433/api')).rejects.toThrow(
      /Non-standard IP encoding/i,
    );
  });

  it('rejects short integer IP (9 digits, e.g. 134744072 = 8.8.8.8)', async () => {
    await expect(validateSsrf('https://134744072/')).rejects.toThrow(/Non-standard IP encoding/i);
  });

  it('rejects hex-encoded PUBLIC IP (spec requires reject ALL non-standard)', async () => {
    await expect(validateSsrf('https://0x08080808/api')).rejects.toThrow(
      /Non-standard IP encoding/i,
    );
  });

  it('rejects hex IP hidden behind userinfo (user@host bypass)', async () => {
    await expect(validateSsrf('https://user@0x7f000001/')).rejects.toThrow(
      /Non-standard IP encoding/i,
    );
  });

  it('rejects hex IP hidden behind user:pass@host', async () => {
    await expect(validateSsrf('https://user:pass@0x08080808/api')).rejects.toThrow(
      /Non-standard IP encoding/i,
    );
  });

  it('rejects IPv6 loopback literal (bracket-wrapped)', async () => {
    await expect(validateSsrf('https://[::1]/')).rejects.toThrow(/private|reserved/i);
  });

  it('accepts public IPv6 literal (bracket-wrapped)', async () => {
    await expect(validateSsrf('https://[2606:4700::1]/')).resolves.toBeUndefined();
  });

  it('rejects IPv4-mapped IPv6 loopback URL', async () => {
    await expect(validateSsrf('https://[::ffff:127.0.0.1]/')).rejects.toThrow(/private|reserved/i);
  });

  it('rejects IPv4-mapped IPv6 private URL', async () => {
    await expect(validateSsrf('https://[::ffff:192.168.1.1]/')).rejects.toThrow(
      /private|reserved/i,
    );
  });
});

describe('validateSsrfIfEnabled', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Smoke-tests the GOLDPAN_SSRF_VALIDATION_ENABLED bypass: the simulated
  // proxy fake-IP case (public domain → 198.18.x.x reserved range) must pass
  // when the flag is off, since that's the entire reason the flag exists.
  it('skips validation when disabled (otherwise-blocked fake-IP URL passes)', async () => {
    await expect(
      validateSsrfIfEnabled('https://baijiahao.baidu.com/s?id=1', false),
    ).resolves.toBeUndefined();
    await expect(validateSsrfIfEnabled('https://192.168.1.1/api', false)).resolves.toBeUndefined();
  });

  it('runs validation when enabled (preserves existing rejection behaviour)', async () => {
    await expect(validateSsrfIfEnabled('https://192.168.1.1/api', true)).rejects.toThrow(
      /private|reserved/i,
    );
  });

  it('does NOT issue a DNS lookup when disabled (avoids cost on flaky / fake-IP networks)', async () => {
    const dns = await import('node:dns');
    const r4 = vi.spyOn(dns.promises, 'resolve4');
    const r6 = vi.spyOn(dns.promises, 'resolve6');
    await validateSsrfIfEnabled('https://example.com/anything', false);
    expect(r4).not.toHaveBeenCalled();
    expect(r6).not.toHaveBeenCalled();
  });
});
