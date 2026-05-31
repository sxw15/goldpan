import * as lark from '@larksuiteoapi/node-sdk';

export type FeishuAppInfoErrorKind =
  | 'unauthorized'
  | 'missing_scope'
  | 'app_inactive'
  | 'owner_missing'
  | 'rate_limited'
  | 'network'
  | 'unknown';

export interface FeishuAppInfoErrorMeta {
  larkCode?: number;
  larkMsg?: string;
  httpStatus?: number;
}

export class FeishuAppInfoError extends Error {
  readonly kind: FeishuAppInfoErrorKind;
  readonly larkCode?: number;
  readonly larkMsg?: string;
  readonly httpStatus?: number;

  constructor(kind: FeishuAppInfoErrorKind, message: string, meta: FeishuAppInfoErrorMeta = {}) {
    super(message);
    this.name = 'FeishuAppInfoError';
    this.kind = kind;
    if (meta.larkCode !== undefined) this.larkCode = meta.larkCode;
    if (meta.larkMsg !== undefined) this.larkMsg = meta.larkMsg;
    if (meta.httpStatus !== undefined) this.httpStatus = meta.httpStatus;
  }
}

export interface GetFeishuAppOwnerOptions {
  appId: string;
  appSecret: string;
  domain: 'feishu.cn' | 'larksuite.com';
}

export interface FeishuAppOwner {
  /** open_id 格式 — 直接可作为 receive_id_type=open_id 的 receive_id 发 P2P。 */
  ownerId: string;
  /** Lark 应用名（self-build 后台填的），UI 测试 toast 用得到。 */
  appName?: string;
}

const UNAUTHORIZED_CODES = new Set([99991661, 99991663, 99991664, 99991665, 99991668]);
// 99991672 = scope 缺失。app-info 端点撞这条意味着 admin:app.info:readonly
// 没开 — 与发消息端点撞 99991672（缺 im:message）语义不同，server 路由层
// 据 phase 分发不同 errorCode 让 UI 给精准指引。
const MISSING_SCOPE_CODES = new Set([99991672]);
// 232034 = 应用未发布 / tenant 未启用。
const APP_INACTIVE_CODES = new Set([232034]);
const RATE_LIMITED_CODES = new Set([11000, 11003]);

function classifyLarkBusinessCode(code: number): FeishuAppInfoErrorKind {
  if (UNAUTHORIZED_CODES.has(code)) return 'unauthorized';
  if (MISSING_SCOPE_CODES.has(code)) return 'missing_scope';
  if (APP_INACTIVE_CODES.has(code)) return 'app_inactive';
  if (RATE_LIMITED_CODES.has(code)) return 'rate_limited';
  return 'unknown';
}

const MESSAGES: Record<FeishuAppInfoErrorKind, string> = {
  unauthorized: 'Feishu rejected credentials',
  missing_scope: 'Feishu app missing admin:app.info:readonly scope',
  app_inactive: 'Feishu app not published or inactive in tenant',
  owner_missing: 'Feishu returned no creator/owner — cannot infer P2P recipient',
  rate_limited: 'Feishu rate limit hit',
  network: 'Cannot reach Feishu API',
  unknown: 'Feishu API error',
};

function classifyAxiosError(err: unknown): {
  kind: FeishuAppInfoErrorKind;
  meta: FeishuAppInfoErrorMeta;
} {
  const meta: FeishuAppInfoErrorMeta = {};
  if (!err || typeof err !== 'object') {
    return { kind: 'unknown', meta };
  }
  const obj = err as {
    response?: { status?: number; data?: { code?: number; msg?: string } };
    code?: string;
  };
  const status = obj.response?.status;
  const dataCode = obj.response?.data?.code;
  const dataMsg = obj.response?.data?.msg;
  if (typeof status === 'number') meta.httpStatus = status;
  if (typeof dataCode === 'number') meta.larkCode = dataCode;
  if (typeof dataMsg === 'string') meta.larkMsg = dataMsg;
  if (typeof dataCode === 'number' && dataCode !== 0) {
    return { kind: classifyLarkBusinessCode(dataCode), meta };
  }
  if (status === 401) return { kind: 'unauthorized', meta };
  if (status === 429) return { kind: 'rate_limited', meta };
  if (typeof status === 'number' && status >= 500) return { kind: 'unknown', meta };
  if (typeof obj.code === 'string') {
    return { kind: 'network', meta };
  }
  return { kind: 'unknown', meta };
}

/**
 * 拉取应用自己的元信息，主要为了拿 `creator_id` —— 自部署用户配置 App ID/Secret
 * 的人就是 app 创建者，goldpan 据此自动给"配置者本人"发飞书 P2P 测试消息，
 * UI 端因此可以做到"零输入"测试（用户只需点按钮，不填 chat_id / 邮箱 / open_id）。
 *
 * 用 `app_id: 'me'` + `user_id_type: 'open_id'`：
 *   - `me` 让 SDK 自己注入当前 app_id，不需要传两次
 *   - open_id 是 lark im.message.create 的天然 receive_id_type，零转换成本
 *
 * Source: GET /open-apis/application/v6/applications/:app_id?lang=zh_cn&user_id_type=open_id
 *   - 需要 scope: admin:app.info:readonly（self-build app 默认未开通，需用户去飞书后台勾上）
 *   - tenant_access_token 调用，self-build 直接走 SDK 默认 flow
 *
 * 优先 `creator_id`（开发者后台真实创建人），fallback `owner.owner_id`（开发者后台
 * 填写的"应用所有者"，可能与 creator 不同）；都缺时抛 owner_missing。
 */
export async function getFeishuAppOwner(opts: GetFeishuAppOwnerOptions): Promise<FeishuAppOwner> {
  if (!opts.appId) {
    throw new FeishuAppInfoError('unauthorized', 'Feishu app id is empty');
  }
  if (!opts.appSecret) {
    throw new FeishuAppInfoError('unauthorized', 'Feishu app secret is empty');
  }

  let client: lark.Client;
  try {
    client = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain === 'larksuite.com' ? lark.Domain.Lark : lark.Domain.Feishu,
      appType: lark.AppType.SelfBuild,
      // disableTokenCache 不设 — 见 oneshot.ts 同位置注释。
    });
  } catch (err) {
    throw new FeishuAppInfoError(
      'unauthorized',
      err instanceof Error ? err.message : 'Failed to initialize Lark client',
    );
  }

  let result:
    | {
        code?: number;
        msg?: string;
        data?: {
          app?: {
            app_id?: string;
            app_name?: string;
            creator_id?: string;
            owner?: { owner_id?: string };
          };
        };
      }
    | undefined;
  try {
    result = await client.application.application.get({
      params: { lang: 'zh_cn', user_id_type: 'open_id' },
      path: { app_id: 'me' },
    });
  } catch (err) {
    const { kind, meta } = classifyAxiosError(err);
    throw new FeishuAppInfoError(kind, MESSAGES[kind], meta);
  }

  if (result && typeof result.code === 'number' && result.code !== 0) {
    const kind = classifyLarkBusinessCode(result.code);
    const meta: FeishuAppInfoErrorMeta = { larkCode: result.code };
    if (typeof result.msg === 'string') meta.larkMsg = result.msg;
    throw new FeishuAppInfoError(kind, MESSAGES[kind], meta);
  }

  const app = result?.data?.app;
  const ownerId = app?.creator_id ?? app?.owner?.owner_id;
  if (!ownerId) {
    throw new FeishuAppInfoError('owner_missing', MESSAGES.owner_missing);
  }
  const owner: FeishuAppOwner = { ownerId };
  if (typeof app?.app_name === 'string' && app.app_name.length > 0) {
    owner.appName = app.app_name;
  }
  return owner;
}
