import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const applicationGetMock = vi.fn();
const clientCtorMock = vi.fn();

class FakeClient {
  application = { application: { get: applicationGetMock } };
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
  applicationGetMock.mockReset();
  clientCtorMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getFeishuAppOwner', () => {
  test('happy path: returns creator_id (preferred) and appName', async () => {
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    applicationGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        app: {
          app_id: 'cli_x',
          app_name: 'Goldpan Test App',
          creator_id: 'ou_creator_x',
          owner: { owner_id: 'ou_owner_y' },
        },
      },
    });
    const result = await getFeishuAppOwner({
      appId: 'cli_x',
      appSecret: 'secret',
      domain: 'feishu.cn',
    });
    // creator_id 优先于 owner.owner_id —— 前者是真实创建者，后者是后台填写的
    // "应用所有者"（self-build 默认与 creator 同，但 store app 可能不同）。
    expect(result).toEqual({ ownerId: 'ou_creator_x', appName: 'Goldpan Test App' });
    expect(applicationGetMock).toHaveBeenCalledWith({
      params: { lang: 'zh_cn', user_id_type: 'open_id' },
      path: { app_id: 'me' },
    });
  });

  test('falls back to owner.owner_id when creator_id is absent', async () => {
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    applicationGetMock.mockResolvedValueOnce({
      code: 0,
      data: { app: { app_id: 'cli_x', owner: { owner_id: 'ou_owner_y' } } },
    });
    const result = await getFeishuAppOwner({
      appId: 'cli_x',
      appSecret: 'secret',
      domain: 'feishu.cn',
    });
    expect(result.ownerId).toBe('ou_owner_y');
  });

  test('throws owner_missing when both creator_id and owner.owner_id absent', async () => {
    // 防御 — 飞书理论上对 self-build app 至少返回 creator_id，但不能假定。
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    applicationGetMock.mockResolvedValueOnce({
      code: 0,
      data: { app: { app_id: 'cli_x' } },
    });
    await expect(
      getFeishuAppOwner({ appId: 'cli_x', appSecret: 'sec', domain: 'feishu.cn' }),
    ).rejects.toMatchObject({ kind: 'owner_missing' });
  });

  test('domain=larksuite.com routes to Domain.Lark', async () => {
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    applicationGetMock.mockResolvedValueOnce({
      code: 0,
      data: { app: { app_id: 'cli_x', creator_id: 'ou_x' } },
    });
    await getFeishuAppOwner({ appId: 'cli_x', appSecret: 'sec', domain: 'larksuite.com' });
    expect(clientCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'https://open.larksuite.com' }),
    );
  });

  test('empty appId rejects synchronously with kind=unauthorized', async () => {
    const { getFeishuAppOwner, FeishuAppInfoError } = await import(
      '../../src/transport/app-info.js'
    );
    await expect(
      getFeishuAppOwner({ appId: '', appSecret: 'x', domain: 'feishu.cn' }),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(
      getFeishuAppOwner({ appId: '', appSecret: 'x', domain: 'feishu.cn' }),
    ).rejects.toBeInstanceOf(FeishuAppInfoError);
    expect(applicationGetMock).not.toHaveBeenCalled();
  });

  test('result.code=99991663 → kind=unauthorized', async () => {
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    applicationGetMock.mockResolvedValueOnce({ code: 99991663, msg: 'invalid app_secret' });
    await expect(
      getFeishuAppOwner({ appId: 'cli_x', appSecret: 'bad', domain: 'feishu.cn' }),
    ).rejects.toMatchObject({ kind: 'unauthorized', larkCode: 99991663 });
  });

  test('result.code=99991672 → kind=missing_scope (admin:app.info:readonly 缺失)', async () => {
    // 关键 case —— self-build app 默认没开 admin:app.info:readonly，第一次
    // 点测试时大概率会撞这条。larkMsg 自带申请直链，server 透传 UI 让用户
    // 直接点链接开通。
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    const larkMsg =
      'Access denied. One of the following scopes is required: [admin:app.info:readonly]. ' +
      'https://open.feishu.cn/app/cli_x/auth?q=admin:app.info:readonly';
    applicationGetMock.mockResolvedValueOnce({ code: 99991672, msg: larkMsg });
    await expect(
      getFeishuAppOwner({ appId: 'cli_x', appSecret: 'sec', domain: 'feishu.cn' }),
    ).rejects.toMatchObject({
      kind: 'missing_scope',
      larkCode: 99991672,
      larkMsg,
    });
  });

  test('result.code=232034 → kind=app_inactive', async () => {
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    applicationGetMock.mockResolvedValueOnce({
      code: 232034,
      msg: 'The app is unavailable or inactivate in the tenant.',
    });
    await expect(
      getFeishuAppOwner({ appId: 'cli_x', appSecret: 'sec', domain: 'feishu.cn' }),
    ).rejects.toMatchObject({ kind: 'app_inactive', larkCode: 232034 });
  });

  test('result.code=11000 → kind=rate_limited', async () => {
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    applicationGetMock.mockResolvedValueOnce({ code: 11000, msg: 'rate limit' });
    await expect(
      getFeishuAppOwner({ appId: 'cli_x', appSecret: 'sec', domain: 'feishu.cn' }),
    ).rejects.toMatchObject({ kind: 'rate_limited', larkCode: 11000 });
  });

  test('result.code=999999 (未知非 0) → kind=unknown', async () => {
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    applicationGetMock.mockResolvedValueOnce({ code: 999999, msg: 'mystery' });
    await expect(
      getFeishuAppOwner({ appId: 'cli_x', appSecret: 'sec', domain: 'feishu.cn' }),
    ).rejects.toMatchObject({ kind: 'unknown', larkCode: 999999 });
  });

  test('axios HTTP 401 → kind=unauthorized + httpStatus=401', async () => {
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    applicationGetMock.mockRejectedValueOnce({
      response: { status: 401, data: {} },
      code: 'ERR_BAD_REQUEST',
    });
    await expect(
      getFeishuAppOwner({ appId: 'cli_x', appSecret: 'bad', domain: 'feishu.cn' }),
    ).rejects.toMatchObject({ kind: 'unauthorized', httpStatus: 401 });
  });

  test('axios connect-refused → kind=network', async () => {
    const { getFeishuAppOwner } = await import('../../src/transport/app-info.js');
    applicationGetMock.mockRejectedValueOnce({ code: 'ECONNREFUSED' });
    await expect(
      getFeishuAppOwner({ appId: 'cli_x', appSecret: 'sec', domain: 'feishu.cn' }),
    ).rejects.toMatchObject({ kind: 'network' });
  });
});
