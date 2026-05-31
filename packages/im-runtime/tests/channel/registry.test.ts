import { describe, expect, it } from 'vitest';
import { ChannelRegistry } from '../../src/channel/registry.js';
import type { ChannelAdapter } from '../../src/types.js';

const stub = (id: string): ChannelAdapter =>
  ({
    channelId: id,
    capabilities: {
      inlineButtons: false,
      typingIndicator: false,
      richFormat: false,
      maxMessageLength: 4096,
      images: false,
      lifecycleHooks: false,
    },
    defaultFilters: [],
  }) as unknown as ChannelAdapter;

describe('ChannelRegistry', () => {
  it('register + get round-trip', () => {
    const r = new ChannelRegistry();
    r.register(stub('telegram'));
    expect(r.get('telegram')?.channelId).toBe('telegram');
  });

  it('list returns all registered channels in insertion order', () => {
    const r = new ChannelRegistry();
    r.register(stub('telegram'));
    r.register(stub('slack'));
    expect(r.list().map((c) => c.channelId)).toEqual(['telegram', 'slack']);
  });

  it('throws when registering a duplicate channelId', () => {
    const r = new ChannelRegistry();
    r.register(stub('telegram'));
    expect(() => r.register(stub('telegram'))).toThrow(/already registered/);
  });

  it('throws when registering a channel whose channelId is empty', () => {
    const r = new ChannelRegistry();
    expect(() => r.register(stub(''))).toThrow(/non-empty channelId/);
  });
});
