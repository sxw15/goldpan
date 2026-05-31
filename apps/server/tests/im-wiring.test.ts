import { EnvSecretResolver, IMRuntime } from '@goldpan/im-runtime';
import {
  goldpanIMEnvSpec as feishuEnvSpec,
  goldpanIMRegistration as feishuRegistration,
  goldpanIMSettings as feishuSettings,
} from '@goldpan/plugin-im-feishu';
import {
  goldpanIMEnvSpec,
  goldpanIMRegistration,
  goldpanIMSettings,
} from '@goldpan/plugin-im-telegram';
import { describe, expect, it } from 'vitest';

/**
 * Smoke test — guarantees the IM packages still expose their public protocol
 * symbols. If a plugin refactor stops exporting one, server boot would fail
 * silently (loadChannels skips the plugin) — fail loud at unit time instead.
 */
describe('apps/server IM package exports remain statically resolvable', () => {
  it('@goldpan/im-runtime exports', () => {
    expect(typeof IMRuntime).toBe('function');
    expect(typeof EnvSecretResolver).toBe('function');
  });

  it('@goldpan/plugin-im-telegram exports the 3 protocol symbols', () => {
    expect(typeof goldpanIMSettings).toBe('object');
    expect(goldpanIMSettings.manifest.channelId).toBe('telegram');
    expect(goldpanIMEnvSpec.channelId).toBe('telegram');
    expect(typeof goldpanIMRegistration).toBe('function');
  });

  it('@goldpan/plugin-im-feishu exports the 3 protocol symbols', () => {
    expect(typeof feishuSettings).toBe('object');
    expect(feishuSettings.manifest.channelId).toBe('feishu');
    expect(feishuEnvSpec.channelId).toBe('feishu');
    expect(typeof feishuRegistration).toBe('function');
  });
});
