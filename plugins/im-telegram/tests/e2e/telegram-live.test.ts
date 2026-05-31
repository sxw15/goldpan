import { describe, it } from 'vitest';

const TOKEN = process.env.GOLDPAN_TELEGRAM_E2E_TOKEN;
const CHAT = process.env.GOLDPAN_TELEGRAM_E2E_CHAT_ID;

describe.skipIf(!TOKEN || !CHAT)('Live Telegram smoke', () => {
  it('boots the adapter and sends a hello message', async () => {
    const { Bot } = await import('grammy');
    const bot = new Bot(TOKEN!);
    await bot.api.sendMessage(CHAT!, '🪙 goldpan e2e ping');
  });
});
