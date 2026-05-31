import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const messageCreateMock = vi.fn();
const clientCtorMock = vi.fn();

class FakeClient {
  im = { message: { create: messageCreateMock } };
  constructor(opts: unknown) {
    clientCtorMock(opts);
  }
}

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: FakeClient,
  AppType: { SelfBuild: 0, ISV: 1 },
  Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
}));

beforeEach(() => {
  messageCreateMock.mockReset();
  clientCtorMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sendFeishuTestMessage', () => {
  test('happy path: P2P direct via email — calls im.message.create with receive_id_type=email', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockResolvedValueOnce({
      code: 0,
      msg: 'success',
      data: { message_id: 'om_x' },
    });
    await sendFeishuTestMessage({
      appId: 'cli_x',
      appSecret: 'secret',
      domain: 'feishu.cn',
      recipient: 'admin@company.com',
      text: 'hello',
    });
    // 默认 recipientType=email — UI 输入框就是邮箱输入。
    expect(messageCreateMock).toHaveBeenCalledWith({
      params: { receive_id_type: 'email' },
      data: {
        receive_id: 'admin@company.com',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    });
    // 不断言 disableTokenCache —— 故意不设，让 SDK 自动走 tenant_access_token
    // 流程（设 true 会让请求裸发，飞书返回 "Missing access token"）。
    expect(clientCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'cli_x', appSecret: 'secret' }),
    );
    expect(clientCtorMock.mock.calls[0]?.[0]).not.toHaveProperty('disableTokenCache');
  });

  test('explicit recipientType=open_id is forwarded to receive_id_type', async () => {
    // recipientType 留给程序化场景 — UI 永远走默认 email，但 transport 不应
    // 把这个能力锁死在 email 上。
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockResolvedValueOnce({ code: 0 });
    await sendFeishuTestMessage({
      appId: 'cli_x',
      appSecret: 'secret',
      domain: 'feishu.cn',
      recipient: 'ou_xxxxxx',
      recipientType: 'open_id',
      text: 'hi',
    });
    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: 'open_id' },
        data: expect.objectContaining({ receive_id: 'ou_xxxxxx' }),
      }),
    );
  });

  test('domain=larksuite.com routes to Domain.Lark in client constructor', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockResolvedValueOnce({ code: 0 });
    await sendFeishuTestMessage({
      appId: 'cli_x',
      appSecret: 'secret',
      domain: 'larksuite.com',
      recipient: 'admin@company.com',
      text: 'hi',
    });
    expect(clientCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'https://open.larksuite.com' }),
    );
  });

  test('empty appId rejects synchronously with kind=unauthorized — no SDK call', async () => {
    const { sendFeishuTestMessage, FeishuTestError } = await import(
      '../../src/transport/oneshot.js'
    );
    await expect(
      sendFeishuTestMessage({
        appId: '',
        appSecret: 'x',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ name: 'FeishuTestError', kind: 'unauthorized' });
    expect(messageCreateMock).not.toHaveBeenCalled();
    // Constructor never reached either
    expect(clientCtorMock).not.toHaveBeenCalled();
    // Class-level instanceof check
    await expect(
      sendFeishuTestMessage({
        appId: '',
        appSecret: 'x',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(FeishuTestError);
  });

  test('empty appSecret rejects with kind=unauthorized', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: '',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  test('empty recipient rejects with kind=recipient_not_found — no SDK call', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'x',
        domain: 'feishu.cn',
        recipient: '',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'recipient_not_found' });
    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  test('result.code=99991663 → kind=unauthorized + larkCode preserved', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockResolvedValueOnce({ code: 99991663, msg: 'invalid app_secret' });
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'bad',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({
      kind: 'unauthorized',
      larkCode: 99991663,
      larkMsg: 'invalid app_secret',
    });
  });

  test('result.code=99991672 → kind=missing_scope + larkMsg with permission link preserved', async () => {
    // P2P send 路径同样需要 im:message scope，撞 99991672 时 larkMsg 自带申请直链。
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    const larkMsg =
      'Access denied. One of the following scopes is required: [im:message]. ' +
      'https://open.feishu.cn/app/cli_x/auth?q=im:message';
    messageCreateMock.mockResolvedValueOnce({ code: 99991672, msg: larkMsg });
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'sec',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({
      kind: 'missing_scope',
      larkCode: 99991672,
      larkMsg,
    });
  });

  test('result.code=232034 → kind=app_inactive (应用未发布/未启用)', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockResolvedValueOnce({
      code: 232034,
      msg: 'The app is unavailable or inactivate in the tenant.',
    });
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'sec',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'app_inactive', larkCode: 232034 });
  });

  test('result.code=230001 → kind=recipient_not_found (邮箱无效 / 用户不在可见性范围 / receive_id 格式错)', async () => {
    // 飞书 230001 = "参数错"的统一兜底：UI 端 P2P send 三种最常见失败 (邮箱
    // 不对应飞书账号 / 用户不在应用可见范围 / open_id 格式错) 都归这一码。
    // 文案上引导用户同时检查"邮箱"+"应用可见范围"两件事。
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockResolvedValueOnce({
      code: 230001,
      msg: 'invalid receive_id',
    });
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'x',
        domain: 'feishu.cn',
        recipient: 'nobody@nowhere.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'recipient_not_found', larkCode: 230001 });
  });

  test('result.code=11000 → kind=rate_limited', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockResolvedValueOnce({ code: 11000, msg: 'rate limit' });
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'x',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'rate_limited', larkCode: 11000 });
  });

  test('result.code=999999 (未知非 0) → kind=unknown + larkCode preserved', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockResolvedValueOnce({ code: 999999, msg: 'mystery' });
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'x',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'unknown', larkCode: 999999 });
  });

  test('axios HTTP 401 (no body code) → kind=unauthorized + httpStatus=401', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockRejectedValueOnce({
      response: { status: 401, data: {} },
      code: 'ERR_BAD_REQUEST',
    });
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'bad',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'unauthorized', httpStatus: 401 });
  });

  test('axios HTTP 200 with body code (caught case) → 业务码优先于 status', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    // SDK 通常 200+code != 0 不抛，但保险起见测试 axios catch 路径里业务码也能走分类。
    messageCreateMock.mockRejectedValueOnce({
      response: { status: 200, data: { code: 230001, msg: 'invalid receive_id' } },
    });
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'x',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'recipient_not_found', larkCode: 230001 });
  });

  test('axios HTTP 429 (no body code) → kind=rate_limited', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockRejectedValueOnce({
      response: { status: 429, data: {} },
    });
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'x',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'rate_limited', httpStatus: 429 });
  });

  test('axios connect-refused (no response, has code) → kind=network', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockRejectedValueOnce({ code: 'ECONNREFUSED' });
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'x',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  test('plain Error throw (non-axios shape) → kind=unknown', async () => {
    const { sendFeishuTestMessage } = await import('../../src/transport/oneshot.js');
    messageCreateMock.mockRejectedValueOnce(new Error('boom'));
    await expect(
      sendFeishuTestMessage({
        appId: 'cli_x',
        appSecret: 'x',
        domain: 'feishu.cn',
        recipient: 'a@b.com',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ kind: 'unknown' });
  });
});
