import { describe, expect, it } from 'vitest';
import { EnvSecretResolver } from '../../src/secrets/env-resolver.js';

describe('EnvSecretResolver', () => {
  it('maps env:// path to its env var', () => {
    const env = { GOLDPAN_IM_TELEGRAM_BOT_TOKEN: 'tok-abc' };
    const r = new EnvSecretResolver(env);
    expect(r.resolve('env://GOLDPAN_IM_TELEGRAM_BOT_TOKEN')).toBe('tok-abc');
  });

  it('throws when a referenced env var is missing', () => {
    const r = new EnvSecretResolver({});
    expect(() => r.resolve('env://GOLDPAN_MISSING')).toThrow(
      /missing required env var: GOLDPAN_MISSING/,
    );
  });

  it('throws when scheme is not env://', () => {
    const r = new EnvSecretResolver({});
    expect(() => r.resolve('vault://secret/foo')).toThrow(/unsupported secret scheme/);
  });

  it('returns plain values unchanged when no scheme is present', () => {
    const r = new EnvSecretResolver({});
    expect(r.resolve('plain-token-123')).toBe('plain-token-123');
  });
});
