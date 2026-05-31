import type {
  ChannelAdapter,
  ImChannelEnvSpec,
  ImChannelRegistrationFn,
  ImSettingsActionContext,
  ImSettingsActionResult,
  ImSettingsManifest,
  ImSettingsModule,
} from '@goldpan/im-runtime';
import { z } from 'zod';
import { createTelegramAdapter } from './adapter.js';
import { sendTelegramTestMessage, TelegramTestError } from './transport/oneshot.js';

export interface TelegramChannelSlice {
  enabled: boolean;
  botTokenRef: string;
  allowedChatIds: ReadonlyArray<string>;
}

export const goldpanIMEnvSpec: ImChannelEnvSpec<TelegramChannelSlice> = {
  channelId: 'telegram',
  envSchema: {
    GOLDPAN_IM_TELEGRAM_BOT_TOKEN: z.string().default(''),
    GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS: z.string().default(''),
    GOLDPAN_IM_TELEGRAM_ENABLED: z.enum(['true', 'false']).default('true'),
  },
  parse: (parsed) => ({
    enabled:
      String(parsed.GOLDPAN_IM_TELEGRAM_BOT_TOKEN ?? '').length > 0 &&
      parsed.GOLDPAN_IM_TELEGRAM_ENABLED === 'true',
    botTokenRef: String(parsed.GOLDPAN_IM_TELEGRAM_BOT_TOKEN ?? ''),
    allowedChatIds: String(parsed.GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }),
  // Bridge envSpec slice (adapter-friendly shape) → manifest field names
  // (web/handler-friendly). Secret refs (e.g. botTokenRef) get resolved here
  // so handler.ctx.values.botToken is the actual secret string.
  toValues: (slice, resolver) => ({
    botToken: resolver.resolve(slice.botTokenRef),
    allowedChatIds: slice.allowedChatIds.join(','),
  }),
};

/**
 * Spec-compliant flat registration function. The protocol passes `slice`
 * typed `unknown` so any plugin can implement the same callable shape;
 * we narrow it to TelegramChannelSlice locally.
 *
 * Returns null when channel is disabled (botToken absent or enable=false) —
 * `composeIMRuntime` skips the runtime.register call in that case.
 */
export const goldpanIMRegistration: ImChannelRegistrationFn = (slice, resolver, deps) => {
  const s = slice as TelegramChannelSlice;
  if (!s.enabled) return null;
  const botToken = resolver.resolve(s.botTokenRef);
  const adapter: ChannelAdapter = createTelegramAdapter({
    conversationRepo: deps.conversationRepo,
  });
  return {
    adapter,
    channelConfig: {
      allowedChatIds: s.allowedChatIds,
    },
    secrets: { botToken },
  };
};

const manifest: ImSettingsManifest = {
  channelId: 'telegram',
  branding: {
    name: { en: 'Telegram', zh: 'Telegram' },
  },
  enable: {
    envKey: 'GOLDPAN_IM_TELEGRAM_ENABLED',
    label: { en: 'Enable Telegram', zh: '启用 Telegram' },
    // UI fresh-state default: OFF —— 用户没显式开过就不该把渠道默认渲染成「启用」，
    // 否则 onboarding / 全新 settings 页都会让用户面对一堆「打开但没填」的渠道卡。
    // 注意：env spec 仍 default 'true'（runtime 视 token 存在与否决定是否真开），
    // 这只影响 UI 的初始 Toggle 状态。
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
      hint: {
        en: 'Comma-separated. Use @userinfobot to find your chat id.',
        zh: '逗号分隔。用 @userinfobot 查询自己的 chat id。',
      },
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
        not_configured: { en: 'Bot token not set', zh: '未配置 Bot Token' },
        no_recipient: { en: 'No chat ID configured', zh: '未配置 Chat ID' },
        bad_token: {
          en: 'Invalid bot token — verify with BotFather',
          zh: 'Bot Token 无效 — 在 BotFather 验证',
        },
        bad_chat_id: {
          en: 'Chat ID not found — bot must be added to that chat',
          zh: 'Chat ID 不存在 — bot 必须在该会话内',
        },
        bot_forbidden: {
          en: 'Bot blocked or kicked from the chat',
          zh: 'Bot 被屏蔽或踢出会话',
        },
        rate_limited: {
          en: 'Telegram rate limit hit — try again shortly',
          zh: '触发 Telegram 限流 — 稍后重试',
        },
        network_error: { en: 'Cannot reach Telegram API', zh: '无法访问 Telegram API' },
        internal: { en: 'Internal server error — see logs', zh: '服务器内部错误 — 查看日志' },
      },
    },
  ],
  setupGuide: {
    allDoneTitle: { en: 'Telegram setup completed', zh: '已完成 Telegram 接入' },
    steps: [
      {
        id: 'create_bot',
        title: { en: 'Create the bot via BotFather', zh: '在 BotFather 创建 bot' },
        desc: {
          en: 'Open BotFather, send /newbot and follow the prompts. Save the API token shown after creation.',
          zh: '打开 BotFather，发送 /newbot 按提示完成，保存最后给的 API Token。',
        },
        images: ['01-botfather-start.png', '02-newbot-conversation.png'],
        externalLink: {
          label: { en: 'Open @BotFather', zh: '打开 @BotFather' },
          href: 'https://t.me/BotFather',
        },
      },
      {
        id: 'find_bot',
        title: {
          en: 'Open your new bot and send /start',
          zh: '打开你的新 bot 并发送 /start',
        },
        desc: {
          en: 'Search for the bot username (e.g. @MyGoldpanBot), open its chat and tap Start. This makes Telegram willing to deliver messages from the bot to you.',
          zh: '搜索 bot 用户名（如 @MyGoldpanBot），打开会话并点击 Start。否则 Telegram 不允许 bot 主动给你发消息。',
        },
        images: ['03-search-my-bot.png', '04-bot-chat-start.png'],
      },
      {
        id: 'get_chat_id',
        title: {
          en: 'Get your chat ID via @userinfobot',
          zh: '用 @userinfobot 查 chat ID',
        },
        desc: {
          en: 'Send /start to @userinfobot. It replies with your numeric Telegram ID — that goes into "Allowed chat IDs".',
          zh: '给 @userinfobot 发 /start。它会回复你的数字 ID — 填入"允许的 Chat ID"。',
        },
        images: ['05-search-userinfobot.png', '06-userinfobot-intro.png', '07-get-chat-id.png'],
        externalLink: {
          label: { en: 'Open @userinfobot', zh: '打开 @userinfobot' },
          href: 'https://t.me/userinfobot',
        },
      },
    ],
  },
};

const handlers: Record<string, (ctx: ImSettingsActionContext) => Promise<ImSettingsActionResult>> =
  {
    test: async (ctx) => {
      const token = String(ctx.values.botToken ?? '');
      const chatId = String(ctx.values.allowedChatIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (token.length === 0) {
        return { ok: false, code: 'not_configured', message: 'Bot token not configured' };
      }
      if (chatId === undefined) {
        return { ok: false, code: 'no_recipient', message: 'No chat id configured' };
      }
      const text =
        ctx.language === 'zh'
          ? 'Goldpan 测试消息：你的 Telegram bot 配置正常 ✅'
          : 'Goldpan test message: your Telegram bot is working ✅';
      try {
        await sendTelegramTestMessage({ token, chatId, text });
        return { ok: true, data: { sentTo: chatId } };
      } catch (err) {
        if (err instanceof TelegramTestError) {
          ctx.logger.warn('Telegram test rejected', { kind: err.kind, errorCode: err.errorCode });
          const codeMap: Record<string, string> = {
            unauthorized: 'bad_token',
            chat_not_found: 'bad_chat_id',
            forbidden: 'bot_forbidden',
            rate_limited: 'rate_limited',
            network: 'network_error',
            unknown: 'internal',
          };
          return {
            ok: false,
            code: codeMap[err.kind] ?? 'internal',
            message: 'Telegram API error', // generic — never echo err.kind details for safety
          };
        }
        throw err; // server dispatcher catches and redacts
      }
    },
  };

export const goldpanIMSettings: ImSettingsModule = { manifest, handlers };
