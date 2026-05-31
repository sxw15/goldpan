import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchBotOpenId = vi.fn();
const sendLarkMessage = vi.fn();
const createLarkClient = vi.fn();
const createFeishuTransport = vi.fn();

vi.mock('../src/bot-identity.js', () => ({
  fetchBotOpenId,
}));

vi.mock('../src/sdk/message-send.js', () => ({
  sendLarkMessage,
}));

vi.mock('../src/sdk/ws-factory.js', () => ({
  createLarkClient,
  createEventDispatcher: vi.fn(),
  createWSClient: vi.fn(),
}));

vi.mock('../src/transport/ws-client.js', () => ({
  createFeishuTransport,
}));

describe('createFeishuAdapter send path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchBotOpenId.mockResolvedValue('ou_bot');
    sendLarkMessage.mockResolvedValue({ messageId: 'om_reply' });
    createLarkClient.mockReturnValue({ client: 'fake' });
    createFeishuTransport.mockResolvedValue({
      start: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    });
  });

  it('forwards SessionRef.threadId to the outbound Lark send call', async () => {
    const { createFeishuAdapter } = await import('../src/adapter.js');
    const adapter = createFeishuAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    let installedSendReply:
      | ((
          ref: {
            channelId: string;
            accountId: string;
            chatId: string;
            userId: string;
            threadId?: string;
          },
          payload: { kind: 'text'; text: string },
        ) => Promise<void>)
      | undefined;
    await adapter.start({
      dispatch: vi.fn(async () => {}),
      installSendReply: (fn) => {
        installedSendReply = fn as typeof installedSendReply;
      },
      configureCommandParser: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      language: 'en',
      channelConfig: {
        appId: 'cli_x',
        appSecret: 'secret',
        domain: 'feishu.cn',
      },
      secrets: { appSecret: 'secret' },
    });

    expect(installedSendReply).toBeTypeOf('function');
    await installedSendReply?.(
      {
        channelId: 'feishu',
        accountId: 'cli_x',
        chatId: 'oc_1',
        userId: 'ou_user',
        threadId: 'omt_1',
      },
      { kind: 'text', text: 'hello' },
    );

    expect(sendLarkMessage).toHaveBeenCalledWith(
      { client: 'fake' },
      expect.objectContaining({
        chatId: 'oc_1',
        parentId: 'omt_1',
        msgType: 'text',
      }),
    );
  });
});
