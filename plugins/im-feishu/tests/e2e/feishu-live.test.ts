import { describe, expect, it } from 'vitest';

const APP_ID = process.env.GOLDPAN_FEISHU_E2E_APP_ID;
const APP_SECRET = process.env.GOLDPAN_FEISHU_E2E_APP_SECRET;
const TARGET_CHAT = process.env.GOLDPAN_FEISHU_E2E_CHAT_ID;

const skip = !APP_ID || !APP_SECRET || !TARGET_CHAT;

describe.skipIf(skip)('Feishu live e2e (opt-in)', () => {
  it('connects WSClient + sends one text message + receives it back', {
    timeout: 30_000,
  }, async () => {
    const lark = await import('@larksuiteoapi/node-sdk');
    const domain = 'https://open.feishu.cn';
    const client = new lark.Client({
      appId: APP_ID!,
      appSecret: APP_SECRET!,
      domain,
    });

    let received = '';
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (event: unknown) => {
        const m = (event as { event: { message: { content: string } } }).event.message;
        try {
          received = (JSON.parse(m.content) as { text?: string }).text ?? '';
        } catch {
          // ignore malformed payloads
        }
      },
    });
    const wsClient = new lark.WSClient({
      appId: APP_ID!,
      appSecret: APP_SECRET!,
      domain,
    });

    await wsClient.start({ eventDispatcher: dispatcher });
    const echo = `goldpan e2e ${Date.now()}`;
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: TARGET_CHAT!,
        msg_type: 'text',
        content: JSON.stringify({ text: echo }),
      },
    });
    // Wait up to 10s for the bot to see its own send.
    for (let i = 0; i < 50; i++) {
      if (received.includes(echo)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    wsClient.close();
    expect(received).toContain(echo);
  });
});
