import * as lark from '@larksuiteoapi/node-sdk';

export type FeishuTestErrorKind =
  | 'unauthorized'
  | 'missing_scope'
  | 'app_inactive'
  | 'recipient_not_found'
  | 'rate_limited'
  | 'network'
  | 'unknown';

export interface FeishuTestErrorMeta {
  /** Lark business error code from `response.data.code`. Surfaced to logs only. */
  larkCode?: number;
  /** Lark error message from `response.data.msg`. Surfaced to logs only. */
  larkMsg?: string;
  /** HTTP status (for axios errors). */
  httpStatus?: number;
}

export class FeishuTestError extends Error {
  readonly kind: FeishuTestErrorKind;
  readonly larkCode?: number;
  readonly larkMsg?: string;
  readonly httpStatus?: number;

  constructor(kind: FeishuTestErrorKind, message: string, meta: FeishuTestErrorMeta = {}) {
    super(message);
    this.name = 'FeishuTestError';
    this.kind = kind;
    if (meta.larkCode !== undefined) this.larkCode = meta.larkCode;
    if (meta.larkMsg !== undefined) this.larkMsg = meta.larkMsg;
    if (meta.httpStatus !== undefined) this.httpStatus = meta.httpStatus;
  }
}

export type FeishuRecipientType = 'email' | 'open_id' | 'user_id' | 'union_id';

export interface SendFeishuTestMessageOptions {
  appId: string;
  appSecret: string;
  domain: 'feishu.cn' | 'larksuite.com';
  /**
   * 收件人标识。P2P 直发不需要 chat_id —— bot 直接给用户发私聊，
   * 飞书自动建立 P2P 会话。
   */
  recipient: string;
  /**
   * 收件人标识类型。默认 email：self-host 用户最容易直接填自己的飞书绑定邮箱
   * （open_id / user_id 需要去飞书后台找）。其他类型留给程序化场景。
   */
  recipientType?: FeishuRecipientType;
  text: string;
}

// 飞书业务错误码到 kind 的映射。保守列已知最常见的几条 — 其余归 `unknown`，
// server 会落到 `internal` 并把 larkCode/msg 写入日志便于自部署用户排查。
// Source: https://open.feishu.cn/document/server-docs/getting-started/api-call-guide/error-codes
const UNAUTHORIZED_CODES = new Set([99991661, 99991663, 99991664, 99991665, 99991668]);
// 99991672 = 应用未开通所需的权限范围（区别于"用户不在可见性范围"的语义 —
// 前者是开发者去飞书后台申请 scope，后者是把目标用户加进可见范围）。
// 飞书 msg 自带申请链接，server 透传 larkMsg 让 UI 直接展示给 self-host 用户。
const MISSING_SCOPE_CODES = new Set([99991672]);
// 232034 = 应用未在 tenant 启用 / 未发布版本。飞书 onboarding 三大卡点之一
// (见 list-chats.ts 同名 set 的注释)。
const APP_INACTIVE_CODES = new Set([232034]);
// 230001 = 飞书 P2P 路径下"参数错"的统一兜底：receive_id 格式不对、邮箱不
// 对应任何飞书账号、用户不在应用可见性范围内 —— 飞书都归到这一个码。
// 文案上引导用户同时检查"邮箱是否飞书绑定"+"用户是否在应用可见范围"。
// Source: https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-resolve-error-230001
const RECIPIENT_NOT_FOUND_CODES = new Set([230001]);
const RATE_LIMITED_CODES = new Set([11000, 11003]);

function classifyLarkBusinessCode(code: number): FeishuTestErrorKind {
  if (UNAUTHORIZED_CODES.has(code)) return 'unauthorized';
  if (MISSING_SCOPE_CODES.has(code)) return 'missing_scope';
  if (APP_INACTIVE_CODES.has(code)) return 'app_inactive';
  if (RECIPIENT_NOT_FOUND_CODES.has(code)) return 'recipient_not_found';
  if (RATE_LIMITED_CODES.has(code)) return 'rate_limited';
  return 'unknown';
}

const MESSAGES: Record<FeishuTestErrorKind, string> = {
  unauthorized: 'Feishu rejected credentials',
  missing_scope: 'Feishu app missing required permission scope',
  app_inactive: 'Feishu app not published or inactive in tenant',
  recipient_not_found: 'Recipient not found or not in app availability scope',
  rate_limited: 'Feishu rate limit hit',
  network: 'Cannot reach Feishu API',
  unknown: 'Feishu API error',
};

/**
 * Lark SDK 内部用 axios，HTTP 失败时直接 rethrow 原始 AxiosError；HTTP 200
 * 但飞书业务错（code != 0）则因为 response interceptor `return resp.data`
 * 不抛错，需要在 happy-path 后自己检查 code。
 *
 * 不 instanceof axios.AxiosError — SDK 内部 axios 版本与外层版本可能不同，
 * instanceof 跨包不可靠。改用 duck typing 看 `response.data.code` /
 * `response.status` / `code` 三个字段足够覆盖 axios 错误形状。
 */
function classifyAxiosError(err: unknown): {
  kind: FeishuTestErrorKind;
  meta: FeishuTestErrorMeta;
} {
  const meta: FeishuTestErrorMeta = {};
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
  // 业务码优先 — 飞书 401 + body code=99991663 都表"凭据错"，按业务码精确分类。
  if (typeof dataCode === 'number' && dataCode !== 0) {
    return { kind: classifyLarkBusinessCode(dataCode), meta };
  }
  if (status === 401) return { kind: 'unauthorized', meta };
  if (status === 429) return { kind: 'rate_limited', meta };
  if (typeof status === 'number' && status >= 500) return { kind: 'unknown', meta };
  // 无 HTTP response → axios connect/timeout/DNS 错（err.code 形如 'ECONNREFUSED'）。
  if (typeof obj.code === 'string') {
    return { kind: 'network', meta };
  }
  return { kind: 'unknown', meta };
}

export async function sendFeishuTestMessage(opts: SendFeishuTestMessageOptions): Promise<void> {
  // 顶部 self-validation：把 plugin 函数契约收紧，调用方少一份 guard。
  if (!opts.appId) {
    throw new FeishuTestError('unauthorized', 'Feishu app id is empty');
  }
  if (!opts.appSecret) {
    throw new FeishuTestError('unauthorized', 'Feishu app secret is empty');
  }
  if (!opts.recipient) {
    throw new FeishuTestError('recipient_not_found', 'Feishu recipient is empty');
  }
  const recipientType: FeishuRecipientType = opts.recipientType ?? 'email';

  let client: lark.Client;
  try {
    client = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain === 'larksuite.com' ? lark.Domain.Lark : lark.Domain.Feishu,
      // SelfBuild = enterprise self-built app，走 tenant_access_token 流程。
      appType: lark.AppType.SelfBuild,
      // 不设 disableTokenCache。SDK 里这个 flag 的实际语义是"完全跳过 token
      // 获取，由 caller 自己挂 Authorization header"（lib/index.js:83968），
      // 不是字面的"不缓存"。设 true 会让请求裸发出去，飞书返回 99991661
      // "Missing access token for authorization"。让 SDK 走默认的
      // tenant_access_token 流程；token 是 (appId, domain) 维度的进程内
      // module-level cache，跟主流程 IM runtime 共享反而省一次 token 调用。
    });
  } catch (err) {
    throw new FeishuTestError(
      'unauthorized',
      err instanceof Error ? err.message : 'Failed to initialize Lark client',
    );
  }

  let result: { code?: number; msg?: string } | undefined;
  try {
    result = (await client.im.message.create({
      params: { receive_id_type: recipientType },
      data: {
        receive_id: opts.recipient,
        msg_type: 'text',
        content: JSON.stringify({ text: opts.text }),
      },
    })) as { code?: number; msg?: string };
  } catch (err) {
    const { kind, meta } = classifyAxiosError(err);
    throw new FeishuTestError(kind, MESSAGES[kind], meta);
  }

  // HTTP 200 但飞书业务错 — SDK response interceptor 直接 return resp.data 不抛。
  if (result && typeof result.code === 'number' && result.code !== 0) {
    const kind = classifyLarkBusinessCode(result.code);
    const meta: FeishuTestErrorMeta = { larkCode: result.code };
    if (typeof result.msg === 'string') meta.larkMsg = result.msg;
    throw new FeishuTestError(kind, MESSAGES[kind], meta);
  }
}
