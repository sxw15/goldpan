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
import { createFeishuAdapter } from './adapter.js';
import { FeishuAppInfoError, getFeishuAppOwner } from './transport/app-info.js';
import { FeishuTestError, sendFeishuTestMessage } from './transport/oneshot.js';

export interface FeishuChannelSlice {
  enabled: boolean;
  appIdRef: string;
  appSecretRef: string;
  encryptKey?: string;
  domain: 'feishu.cn' | 'larksuite.com';
}

export const goldpanIMEnvSpec: ImChannelEnvSpec<FeishuChannelSlice> = {
  channelId: 'feishu',
  envSchema: {
    GOLDPAN_IM_FEISHU_APP_ID: z.string().default(''),
    GOLDPAN_IM_FEISHU_APP_SECRET: z.string().default(''),
    GOLDPAN_IM_FEISHU_ENCRYPT_KEY: z.string().optional(),
    GOLDPAN_IM_FEISHU_DOMAIN: z.enum(['feishu.cn', 'larksuite.com']).default('feishu.cn'),
    GOLDPAN_IM_FEISHU_ENABLED: z.enum(['true', 'false']).default('true'),
  },
  parse: (parsed) => {
    const appId = String(parsed.GOLDPAN_IM_FEISHU_APP_ID ?? '');
    const appSecret = String(parsed.GOLDPAN_IM_FEISHU_APP_SECRET ?? '');
    const configured = appId.length > 0 && appSecret.length > 0;
    if (appId.length > 0 !== appSecret.length > 0) {
      // Asymmetry warning — only one of the pair is set. Channel will be disabled.
      console.warn(
        'Feishu channel disabled: requires both GOLDPAN_IM_FEISHU_APP_ID and GOLDPAN_IM_FEISHU_APP_SECRET',
      );
    }
    return {
      enabled: configured && parsed.GOLDPAN_IM_FEISHU_ENABLED === 'true',
      appIdRef: appId,
      appSecretRef: appSecret,
      ...(configured &&
      typeof parsed.GOLDPAN_IM_FEISHU_ENCRYPT_KEY === 'string' &&
      parsed.GOLDPAN_IM_FEISHU_ENCRYPT_KEY.length > 0
        ? { encryptKey: parsed.GOLDPAN_IM_FEISHU_ENCRYPT_KEY }
        : {}),
      domain: (parsed.GOLDPAN_IM_FEISHU_DOMAIN ?? 'feishu.cn') as 'feishu.cn' | 'larksuite.com',
    };
  },
  // Bridge envSpec slice → manifest field names (T12 manifest fields:
  // appId / appSecret / encryptKey / domain). `resolver.resolve` on plain
  // strings (no `://`) returns input as-is, so cli_xxx app IDs pass
  // through unchanged; env:// refs resolve to the actual secret.
  toValues: (slice, resolver) => ({
    appId: resolver.resolve(slice.appIdRef),
    appSecret: resolver.resolve(slice.appSecretRef),
    encryptKey: slice.encryptKey,
    domain: slice.domain,
  }),
};

/** Spec-compliant flat registration. See spec §6.4 + Telegram T7 for rationale. */
export const goldpanIMRegistration: ImChannelRegistrationFn = (slice, resolver, deps) => {
  const s = slice as FeishuChannelSlice;
  if (!s.enabled) return null;
  const appSecret = resolver.resolve(s.appSecretRef);
  const adapter: ChannelAdapter = createFeishuAdapter({
    conversationRepo: deps.conversationRepo,
  });
  return {
    adapter,
    channelConfig: {
      appId: s.appIdRef,
      appSecret,
      domain: s.domain,
      ...(s.encryptKey !== undefined ? { encryptKey: s.encryptKey } : {}),
    },
    secrets: { appSecret },
  };
};

const FEISHU_PERMISSIONS_JSON = `{
  "scopes": {
    "tenant": [
      "admin:app.info:readonly",
      "application:application:self_manage",
      "im:chat",
      "im:chat:read",
      "im:chat:readonly",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot"
    ],
    "user": [
      "admin:app.info:readonly"
    ]
  }
}`;

const manifest: ImSettingsManifest = {
  channelId: 'feishu',
  branding: {
    name: { en: 'Feishu / Lark', zh: '飞书 / Lark' },
  },
  enable: {
    envKey: 'GOLDPAN_IM_FEISHU_ENABLED',
    label: { en: 'Enable Feishu', zh: '启用飞书' },
    // UI fresh-state default: OFF —— 同 telegram，用户没显式开过就别把渠道默认渲染
    // 成「启用」。env spec runtime 默认仍由 credentials 完整性决定。
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
      name: 'appSecret',
      kind: 'secret',
      label: { en: 'App Secret', zh: 'App Secret' },
      envKey: 'GOLDPAN_IM_FEISHU_APP_SECRET',
      required: true,
      requiresRestart: true,
    },
    {
      name: 'encryptKey',
      kind: 'secret',
      label: { en: 'Encrypt key', zh: 'Encrypt Key' },
      hint: {
        en: 'Optional. Set if you enabled event encryption in the Lark admin panel.',
        zh: '可选。仅当在飞书后台开启事件加密时填写。',
      },
      envKey: 'GOLDPAN_IM_FEISHU_ENCRYPT_KEY',
      requiresRestart: true,
    },
  ],
  actions: [
    {
      id: 'test',
      kind: 'test',
      label: { en: 'Send test message', zh: '发送测试消息' },
      requires: ['appId', 'appSecret'],
      errorMessages: {
        not_configured: {
          en: 'App ID or App Secret missing',
          zh: '未配置 App ID 或 App Secret',
        },
        bad_credentials: {
          en: 'Invalid app id or secret — check the Lark admin panel',
          zh: 'App ID 或 Secret 错误 — 在飞书后台核对',
        },
        owner_lookup_missing_scope: {
          en: 'App is missing admin:app.info:readonly scope',
          zh: '应用缺少 admin:app.info:readonly 权限',
        },
        missing_scope: {
          en: 'App is missing im:message scope',
          zh: '应用缺少 im:message 权限',
        },
        app_inactive: {
          en: 'App is not published or inactive in this tenant',
          zh: '应用未发布或在该 tenant 失效',
        },
        owner_missing: {
          en: 'Cannot reach app creator account',
          zh: '无法找到应用创建者账号',
        },
        rate_limited: {
          en: 'Feishu rate limit hit — try again shortly',
          zh: '触发飞书限流 — 稍后重试',
        },
        network_error: {
          en: 'Cannot reach Feishu API',
          zh: '无法访问飞书 API',
        },
        internal: {
          en: 'Internal server error — see logs',
          zh: '服务器内部错误 — 查看日志',
        },
      },
    },
  ],
  setupGuide: {
    allDoneTitle: { en: 'Feishu setup completed', zh: '已完成飞书接入' },
    steps: [
      {
        id: 'create_app',
        title: {
          en: 'Create a custom app on the Lark Open Platform',
          zh: '在飞书开放平台创建自建应用',
        },
        desc: {
          en: 'Open https://open.feishu.cn/app, click "Create custom app", fill in name + description.',
          zh: '打开 https://open.feishu.cn/app，点击「创建自建应用」，填名称和描述。',
        },
        images: ['01-create-app-entry.png', '02-create-app-modal.png'],
        externalLink: {
          label: { en: 'Open Feishu console', zh: '打开飞书后台' },
          href: 'https://open.feishu.cn/app',
        },
      },
      {
        id: 'add_bot',
        title: { en: 'Add the Bot capability', zh: '添加机器人能力' },
        desc: {
          en: 'In the app sidebar, find "Add features" → "Bot" and enable it.',
          zh: '在应用侧栏找到「添加应用能力」→「机器人」并启用。',
        },
        images: ['03-add-bot-capability.png', '04-bot-config-page.png'],
      },
      {
        id: 'credentials',
        title: { en: 'Copy App ID + App Secret', zh: '复制 App ID 与 App Secret' },
        desc: {
          en: 'In the Lark console, open your app → "Credentials & Basic Info" page. Copy App ID (starts with cli_) into the "App ID" field below. App Secret is masked by default — click the reveal button next to it, then copy and paste into the "App Secret" field below.',
          zh: '在飞书后台打开你的应用，进入「凭证与基础信息」页面。复制 App ID（cli_xxx 开头）粘贴到下方「App ID」字段；App Secret 默认是掩码，点旁边的按钮显示明文后复制，粘贴到「App Secret」字段。',
        },
        images: [],
      },
      {
        id: 'permissions',
        title: { en: 'Apply the required scopes', zh: '申请所需权限' },
        desc: {
          en: 'Open Permissions → "Batch import" and paste the JSON below. Submit for approval if your tenant requires it.',
          zh: '打开「权限管理」→「批量导入」，粘贴下方 JSON。如 tenant 需审批则提交。',
        },
        images: ['05-import-permissions.png'],
        code: { language: 'json', text: FEISHU_PERMISSIONS_JSON },
      },
      {
        id: 'events',
        title: { en: 'Subscribe to message events', zh: '订阅消息事件' },
        desc: {
          en: 'Open "Events & Callbacks", set Mode to "Long-connection", subscribe to im.message.receive_v1 and im.message.message_read_v1.',
          zh: '打开「事件与回调」，把「订阅方式」设为「长连接」，订阅 im.message.receive_v1 与 im.message.message_read_v1 事件。',
        },
        images: [
          '06-set-subscription-mode.png',
          '07-add-event-button.png',
          '08-add-event-modal.png',
          '09-add-callback-button.png',
          '10-add-callback-modal.png',
        ],
      },
      {
        id: 'publish',
        title: { en: 'Publish a version', zh: '发版' },
        desc: {
          en: 'Click "Create version" → fill version code and notes → submit. Tenants without admin approval flow auto-publish; otherwise wait for tenant admin to approve.',
          zh: '点击「创建版本」，填版本号和说明后提交。无需审批的 tenant 自动发布；否则等管理员通过。',
        },
        images: ['11-publish-version-banner.png'],
      },
    ],
  },
};

const handlers: Record<string, (ctx: ImSettingsActionContext) => Promise<ImSettingsActionResult>> =
  {
    test: async (ctx) => {
      const appId = String(ctx.values.appId ?? '');
      const appSecret = String(ctx.values.appSecret ?? '');
      const domain = (ctx.values.domain ?? 'feishu.cn') as 'feishu.cn' | 'larksuite.com';
      if (appId.length === 0 || appSecret.length === 0) {
        return { ok: false, code: 'not_configured', message: 'Feishu credentials not configured' };
      }
      const text =
        ctx.language === 'zh'
          ? 'Goldpan 测试消息：你的飞书 bot 配置正常 ✅'
          : 'Goldpan test message: your Feishu bot is working ✅';

      let owner: { ownerId: string; appName?: string };
      try {
        owner = await getFeishuAppOwner({ appId, appSecret, domain });
      } catch (err) {
        if (err instanceof FeishuAppInfoError) {
          ctx.logger.warn('Feishu owner-lookup rejected', {
            kind: err.kind,
            larkCode: err.larkCode,
          });
          const codeMap: Record<string, string> = {
            unauthorized: 'bad_credentials',
            missing_scope: 'owner_lookup_missing_scope',
            app_inactive: 'app_inactive',
            owner_missing: 'owner_missing',
            rate_limited: 'rate_limited',
            network: 'network_error',
            unknown: 'internal',
          };
          return {
            ok: false,
            code: codeMap[err.kind] ?? 'internal',
            message: err.larkMsg ?? 'Feishu API error',
          };
        }
        throw err;
      }

      try {
        await sendFeishuTestMessage({
          appId,
          appSecret,
          domain,
          recipient: owner.ownerId,
          recipientType: 'open_id',
          text,
        });
        return { ok: true, data: { sentTo: owner.appName ?? 'app creator' } };
      } catch (err) {
        if (err instanceof FeishuTestError) {
          ctx.logger.warn('Feishu send rejected', { kind: err.kind, larkCode: err.larkCode });
          const codeMap: Record<string, string> = {
            unauthorized: 'bad_credentials',
            missing_scope: 'missing_scope',
            app_inactive: 'app_inactive',
            recipient_not_found: 'owner_missing',
            rate_limited: 'rate_limited',
            network: 'network_error',
            unknown: 'internal',
          };
          return {
            ok: false,
            code: codeMap[err.kind] ?? 'internal',
            message: err.larkMsg ?? 'Feishu API error',
          };
        }
        throw err;
      }
    },
  };

export const goldpanIMSettings: ImSettingsModule = { manifest, handlers };
