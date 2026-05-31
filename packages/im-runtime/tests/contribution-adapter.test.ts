import { resolveContribution, validateContribution } from '@goldpan/core';
import { describe, expect, it } from 'vitest';
import {
  adaptImHandlersToContribution,
  convertImManifestToContribution,
} from '../src/contribution-adapter';
import type { ImSettingsManifest } from '../src/settings';

// Slim copy of telegram's real manifest — keeps this test independent of the
// plugin (which lives outside packages/) but covers every field kind telegram
// actually uses (toggle / secret / text / actions / setup guide).
const TELEGRAM_FIXTURE: ImSettingsManifest = {
  channelId: 'telegram',
  branding: { name: { en: 'Telegram', zh: 'Telegram' } },
  enable: {
    envKey: 'GOLDPAN_IM_TELEGRAM_ENABLED',
    label: { en: 'Enable Telegram', zh: '启用 Telegram' },
    default: false,
  },
  fields: [
    {
      name: 'botToken',
      kind: 'secret',
      label: { en: 'Bot token', zh: 'Bot Token' },
      placeholder: { en: '123456:ABC-DEF...', zh: '123456:ABC-DEF...' },
      envKey: 'GOLDPAN_IM_TELEGRAM_BOT_TOKEN',
      required: true,
      requiresRestart: true,
    },
    {
      name: 'allowedChatIds',
      kind: 'text',
      label: { en: 'Allowed chat IDs', zh: '允许的 Chat ID' },
      hint: { en: 'Comma-separated.', zh: '逗号分隔。' },
      placeholder: { en: '123456789,-100123...', zh: '123456789,-100123...' },
      envKey: 'GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS',
      required: true,
      requiresRestart: true,
    },
  ],
  actions: [
    {
      id: 'test',
      kind: 'test',
      label: { en: 'Send test message', zh: '发送测试消息' },
      requires: ['botToken', 'allowedChatIds'],
      errorMessages: {
        bad_token: { en: 'Invalid bot token', zh: 'Bot Token 无效' },
      },
    },
  ],
  setupGuide: {
    allDoneTitle: { en: 'Telegram setup completed', zh: '已完成 Telegram 接入' },
    steps: [
      {
        id: 'create_bot',
        title: { en: 'Create the bot via BotFather', zh: '在 BotFather 创建 bot' },
        desc: { en: 'Send /newbot', zh: '发送 /newbot' },
        images: ['01.png'],
        externalLink: {
          label: { en: 'Open @BotFather', zh: '打开 @BotFather' },
          href: 'https://t.me/BotFather',
        },
      },
    ],
  },
};

const FEISHU_FIXTURE: ImSettingsManifest = {
  channelId: 'feishu',
  branding: { name: { en: 'Feishu / Lark', zh: '飞书 / Lark' } },
  enable: {
    envKey: 'GOLDPAN_IM_FEISHU_ENABLED',
    label: { en: 'Enable Feishu', zh: '启用飞书' },
    default: false,
  },
  fields: [
    {
      name: 'appId',
      kind: 'text',
      label: { en: 'App ID', zh: 'App ID' },
      placeholder: { en: 'cli_xxxxx', zh: 'cli_xxxxx' },
      envKey: 'GOLDPAN_IM_FEISHU_APP_ID',
      required: true,
      requiresRestart: true,
    },
    {
      name: 'domain',
      kind: 'segmented',
      label: { en: 'Domain', zh: '域' },
      envKey: 'GOLDPAN_IM_FEISHU_DOMAIN',
      options: [
        { value: 'feishu.cn', label: { en: 'feishu.cn', zh: 'feishu.cn（中国）' } },
        { value: 'larksuite.com', label: { en: 'larksuite.com', zh: 'larksuite.com（国际版）' } },
      ],
      default: 'feishu.cn',
      requiresRestart: true,
    },
  ],
  actions: [],
  setupGuide: {
    allDoneTitle: { en: 'Feishu setup completed', zh: '已完成飞书接入' },
    steps: [],
  },
};

describe('convertImManifestToContribution', () => {
  it('round-trips telegram manifest into a valid contribution', () => {
    const contribution = convertImManifestToContribution(TELEGRAM_FIXTURE);
    const result = validateContribution(contribution);
    expect(result.ok).toBe(true);
  });

  it('round-trips feishu manifest into a valid contribution', () => {
    const contribution = convertImManifestToContribution(FEISHU_FIXTURE);
    const result = validateContribution(contribution);
    expect(result.ok).toBe(true);
  });

  it('preserves pluginId from channelId and assigns notify group', () => {
    const contribution = convertImManifestToContribution(TELEGRAM_FIXTURE);
    expect(contribution.pluginId).toBe('telegram');
    expect(contribution.group).toBe('notify');
  });

  it('resolves zh strings end-to-end', () => {
    const contribution = convertImManifestToContribution(TELEGRAM_FIXTURE);
    const resolved = resolveContribution(contribution, 'zh');
    expect(resolved.branding.name).toBe('Telegram');
    expect(resolved.enable?.label).toBe('启用 Telegram');
    expect(resolved.fields[0]?.label).toBe('Bot Token');
    expect(resolved.fields[1]?.hint).toBe('逗号分隔。');
    expect(resolved.actions?.[0]?.label).toBe('发送测试消息');
    expect(resolved.actions?.[0]?.errorMessages?.bad_token).toBe('Bot Token 无效');
    expect(resolved.setupGuide?.steps[0]?.title).toBe('在 BotFather 创建 bot');
    expect(resolved.setupGuide?.steps[0]?.externalLink?.label).toBe('打开 @BotFather');
  });

  it('resolves en strings end-to-end', () => {
    const contribution = convertImManifestToContribution(TELEGRAM_FIXTURE);
    const resolved = resolveContribution(contribution, 'en');
    expect(resolved.fields[0]?.label).toBe('Bot token');
    expect(resolved.setupGuide?.steps[0]?.title).toBe('Create the bot via BotFather');
  });

  it('preserves segmented options with localized labels', () => {
    const contribution = convertImManifestToContribution(FEISHU_FIXTURE);
    const resolved = resolveContribution(contribution, 'zh');
    const domain = resolved.fields.find((f) => f.name === 'domain');
    expect(domain?.kind).toBe('segmented');
    expect(domain?.options).toEqual([
      { value: 'feishu.cn', label: 'feishu.cn（中国）' },
      { value: 'larksuite.com', label: 'larksuite.com（国际版）' },
    ]);
    expect(domain?.default).toBe('feishu.cn');
  });

  it('generates a zod schema that validates a complete form payload', () => {
    const contribution = convertImManifestToContribution(TELEGRAM_FIXTURE);
    const ok = contribution.schema.safeParse({
      botToken: '123:abc',
      allowedChatIds: '123,456',
    });
    expect(ok.success).toBe(true);

    const empty = contribution.schema.safeParse({
      botToken: '',
      allowedChatIds: '',
    });
    expect(empty.success).toBe(false); // required min(1)
  });

  it('generates a zod schema that rejects unknown segmented values', () => {
    const contribution = convertImManifestToContribution(FEISHU_FIXTURE);
    const bad = contribution.schema.safeParse({ appId: 'cli_x', domain: 'gmail.com' });
    expect(bad.success).toBe(false);
  });

  it('replaces unchanged env-ref values with resolved IM env values before dispatch', async () => {
    let captured: Record<string, unknown> | null = null;
    const handlers = adaptImHandlersToContribution(
      {
        test: async (ctx) => {
          captured = ctx.values;
          return { ok: true };
        },
      },
      {
        getRawEnvValue: (name) =>
          ({
            botToken: 'env://GOLDPAN_IM_TELEGRAM_BOT_TOKEN_SECRET',
            allowedChatIds: '123',
          })[name],
        resolveEnvValue: (name) =>
          ({
            botToken: 'resolved-token',
            allowedChatIds: '123',
          })[name],
      },
    );

    await handlers.test?.({
      values: {
        botToken: 'env://GOLDPAN_IM_TELEGRAM_BOT_TOKEN_SECRET',
        allowedChatIds: '456',
      },
      locale: 'en',
      logger: console as never,
      signal: new AbortController().signal,
    });

    expect(captured).toEqual({
      botToken: 'resolved-token',
      allowedChatIds: '456',
    });
  });

  it('does not resolve stale env refs when a dirty form value overrides them', async () => {
    let captured: Record<string, unknown> | null = null;
    const handlers = adaptImHandlersToContribution(
      {
        test: async (ctx) => {
          captured = ctx.values;
          return { ok: true };
        },
      },
      {
        getRawEnvValue: (name) =>
          name === 'botToken' ? 'env://MISSING_TELEGRAM_BOT_TOKEN' : undefined,
        resolveEnvValue: () => {
          throw new Error('should not resolve dirty override');
        },
      },
    );

    await handlers.test?.({
      values: { botToken: 'fresh-token' },
      locale: 'en',
      logger: console as never,
      signal: new AbortController().signal,
    });

    expect(captured).toEqual({ botToken: 'fresh-token' });
  });
});
