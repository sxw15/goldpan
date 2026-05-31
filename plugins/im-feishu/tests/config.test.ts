import { describe, expect, it } from 'vitest';
import { parseFeishuConfig } from '../src/config.js';

describe('parseFeishuConfig', () => {
  it('accepts a fully-specified config', () => {
    const cfg = parseFeishuConfig({
      appId: 'cli_abcdef',
      appSecret: 'secret-xyz',
      encryptKey: 'key-xyz',
      domain: 'feishu.cn',
    });
    expect(cfg).toEqual({
      appId: 'cli_abcdef',
      appSecret: 'secret-xyz',
      encryptKey: 'key-xyz',
      domain: 'feishu.cn',
    });
  });

  it('defaults domain to feishu.cn', () => {
    const cfg = parseFeishuConfig({ appId: 'a', appSecret: 'b' });
    expect(cfg.domain).toBe('feishu.cn');
  });

  it('throws when appId is missing', () => {
    expect(() => parseFeishuConfig({ appSecret: 'b' } as never)).toThrow(/APP_ID/);
  });

  it('throws when appSecret is missing', () => {
    expect(() => parseFeishuConfig({ appId: 'a' } as never)).toThrow(/APP_SECRET/);
  });

  it('rejects explicit empty-string encryptKey', () => {
    expect(() => parseFeishuConfig({ appId: 'a', appSecret: 'b', encryptKey: '' })).toThrow(
      /GOLDPAN_IM_FEISHU_ENCRYPT_KEY/,
    );
  });

  it('accepts undefined encryptKey (optional)', () => {
    const cfg = parseFeishuConfig({ appId: 'a', appSecret: 'b' });
    expect('encryptKey' in cfg).toBe(false);
  });
});
