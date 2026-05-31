export interface FeishuConfig {
  /** Lark application id (e.g. `cli_xxxxx`). */
  appId: string;
  /** Lark application secret. */
  appSecret: string;
  /** Optional event-encrypt key configured in the Lark admin panel. */
  encryptKey?: string;
  /**
   * Domain selector — `feishu.cn` (default, mainland-China apps) or
   * `larksuite.com` (Lark International). The URL form is derived inside the
   * adapter so consumers never have to remember the exact origin.
   */
  domain: 'feishu.cn' | 'larksuite.com';
}

export interface FeishuConfigInput {
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  domain?: 'feishu.cn' | 'larksuite.com';
}

// Shape-level validation lives in this adapter (three-layer discipline —
// `@goldpan/core` treats Feishu env vars as opaque strings beyond the
// enable flag and the APP_ID/APP_SECRET asymmetry warning). Core catches
// the asymmetry case because that path yields `enabled === false` and the
// adapter never runs; everything else is the adapter's responsibility.
export function parseFeishuConfig(input: FeishuConfigInput): FeishuConfig {
  if (!input.appId) {
    throw new Error('Feishu adapter: GOLDPAN_IM_FEISHU_APP_ID is required.');
  }
  if (!input.appSecret) {
    throw new Error('Feishu adapter: GOLDPAN_IM_FEISHU_APP_SECRET is required.');
  }
  if (input.encryptKey === '') {
    throw new Error(
      'Feishu adapter: GOLDPAN_IM_FEISHU_ENCRYPT_KEY is set to empty string; either unset it or provide a real key.',
    );
  }
  return {
    appId: input.appId,
    appSecret: input.appSecret,
    domain: input.domain ?? 'feishu.cn',
    ...(input.encryptKey !== undefined ? { encryptKey: input.encryptKey } : {}),
  };
}
