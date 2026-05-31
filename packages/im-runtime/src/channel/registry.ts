import type { ChannelAdapter } from '../types.js';

export class ChannelRegistry {
  private channels = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    if (!adapter.channelId) {
      throw new Error('ChannelAdapter requires a non-empty channelId');
    }
    if (this.channels.has(adapter.channelId)) {
      throw new Error(`Channel "${adapter.channelId}" is already registered`);
    }
    this.channels.set(adapter.channelId, adapter);
  }

  get(channelId: string): ChannelAdapter | null {
    return this.channels.get(channelId) ?? null;
  }

  list(): ChannelAdapter[] {
    return Array.from(this.channels.values());
  }
}
