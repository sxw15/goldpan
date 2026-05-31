import { describe, expect, it, vi } from 'vitest';
// Relative import — the plugin's package.json exports map only `.` → dist;
// subpath access via `@goldpan/plugin-im-telegram/src/...` is not in exports
// and the workspace's vitest config doesn't self-alias.
import { goldpanIMEnvSpec, goldpanIMSettings } from '../src/settings.js';

const silentLogger = () =>
  ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }) as any;

describe('goldpanIMSettings (telegram)', () => {
  it('manifest has channelId telegram and 2 fields + 1 action', () => {
    expect(goldpanIMSettings.manifest.channelId).toBe('telegram');
    expect(goldpanIMSettings.manifest.fields).toHaveLength(2);
    expect(goldpanIMSettings.manifest.actions).toHaveLength(1);
  });

  it('test handler returns not_configured when no token', async () => {
    const res = await goldpanIMSettings.handlers.test({
      values: { botToken: '', allowedChatIds: '123' },
      language: 'en',
      logger: silentLogger(),
    });
    expect(res).toEqual({ ok: false, code: 'not_configured', message: 'Bot token not configured' });
  });

  it('test handler returns no_recipient when no chat id', async () => {
    const res = await goldpanIMSettings.handlers.test({
      values: { botToken: 'abc:def', allowedChatIds: '' },
      language: 'en',
      logger: silentLogger(),
    });
    expect(res).toEqual({ ok: false, code: 'no_recipient', message: 'No chat id configured' });
  });
});

describe('goldpanIMEnvSpec (telegram)', () => {
  it('parses enabled when token present and ENABLED=true', () => {
    const slice = goldpanIMEnvSpec.parse({
      GOLDPAN_IM_TELEGRAM_BOT_TOKEN: 'abc:def',
      GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS: '123,456',
      GOLDPAN_IM_TELEGRAM_ENABLED: 'true',
    }) as any;
    expect(slice.enabled).toBe(true);
    expect(slice.allowedChatIds).toEqual(['123', '456']);
  });

  it('parses disabled when ENABLED=false', () => {
    const slice = goldpanIMEnvSpec.parse({
      GOLDPAN_IM_TELEGRAM_BOT_TOKEN: 'abc:def',
      GOLDPAN_IM_TELEGRAM_ENABLED: 'false',
    }) as any;
    expect(slice.enabled).toBe(false);
  });

  it('parses disabled when token empty', () => {
    const slice = goldpanIMEnvSpec.parse({
      GOLDPAN_IM_TELEGRAM_BOT_TOKEN: '',
      GOLDPAN_IM_TELEGRAM_ENABLED: 'true',
    }) as any;
    expect(slice.enabled).toBe(false);
  });
});
