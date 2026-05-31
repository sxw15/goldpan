import type { ImChannelEnvSpec } from '@goldpan/im-runtime';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadImChannelConfigs } from './channel-configs.js';

const aSpec: ImChannelEnvSpec<{ token: string }> = {
  channelId: 'a',
  envSchema: { GOLDPAN_IM_A_TOKEN: z.string().default('') },
  parse: (p) => ({ token: String(p.GOLDPAN_IM_A_TOKEN ?? '') }),
  toValues: (slice) => ({ token: slice.token }),
};

const bSpec: ImChannelEnvSpec<{ url: string }> = {
  channelId: 'b',
  envSchema: { GOLDPAN_IM_B_URL: z.string().default('http://default') },
  parse: (p) => ({ url: String(p.GOLDPAN_IM_B_URL ?? '') }),
  toValues: (slice) => ({ url: slice.url }),
};

// `ImChannelEnvSpec<T>` is invariant in `T` (T appears as a `parse`/`toValues`
// argument), so `ImChannelEnvSpec<{ token: string }>` is not assignable to
// `ImChannelEnvSpec<unknown>`. The function signature widens to `unknown` for
// composing heterogeneous specs at runtime — fixtures cast through the same
// widening at the call site.
const specs: ReadonlyArray<ImChannelEnvSpec<unknown>> = [
  aSpec as ImChannelEnvSpec<unknown>,
  bSpec as ImChannelEnvSpec<unknown>,
];

describe('loadImChannelConfigs', () => {
  it('parses both plugins from a shared env object', () => {
    const m = loadImChannelConfigs(
      { GOLDPAN_IM_A_TOKEN: 'abc', GOLDPAN_IM_B_URL: 'http://x' },
      specs,
    );
    expect(m.get('a')).toEqual({ token: 'abc' });
    expect(m.get('b')).toEqual({ url: 'http://x' });
  });

  it('applies defaults for missing keys', () => {
    const m = loadImChannelConfigs({}, specs);
    expect(m.get('a')).toEqual({ token: '' });
    expect(m.get('b')).toEqual({ url: 'http://default' });
  });

  it('throws on zod parse failure', () => {
    const strictSpec: ImChannelEnvSpec<{ port: number }> = {
      channelId: 'c',
      envSchema: { GOLDPAN_IM_C_PORT: z.coerce.number().int().positive() },
      parse: (p) => ({ port: p.GOLDPAN_IM_C_PORT as number }),
      toValues: (slice) => ({ port: String(slice.port) }),
    };
    expect(() =>
      loadImChannelConfigs({ GOLDPAN_IM_C_PORT: 'not-a-number' }, [
        strictSpec as ImChannelEnvSpec<unknown>,
      ]),
    ).toThrow();
  });
});
