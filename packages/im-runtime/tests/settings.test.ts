import { validateImSettingsManifest } from '@goldpan/im-runtime';
import { describe, expect, it } from 'vitest';

const validManifest = {
  channelId: 'demo',
  branding: { name: { en: 'Demo', zh: '演示' } },
  enable: {
    envKey: 'GOLDPAN_IM_DEMO_ENABLED',
    label: { en: 'Enable Demo', zh: '启用演示' },
    default: true,
  },
  fields: [
    {
      name: 'token',
      kind: 'secret',
      label: { en: 'Token', zh: 'Token' },
      envKey: 'GOLDPAN_IM_DEMO_TOKEN',
      required: true,
    },
  ],
  actions: [
    {
      id: 'test',
      kind: 'test',
      label: { en: 'Send test', zh: '发送测试' },
      requires: ['token'],
    },
  ],
  setupGuide: {
    allDoneTitle: { en: 'Done', zh: '完成' },
    steps: [],
  },
};

describe('validateImSettingsManifest', () => {
  it('accepts a complete valid manifest', () => {
    const result = validateImSettingsManifest(validManifest);
    expect(result.ok).toBe(true);
  });

  it('rejects when channelId is missing', () => {
    const { channelId: _, ...rest } = validManifest;
    const result = validateImSettingsManifest(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toContain('channelId');
    }
  });

  it('rejects when a localizedString is missing zh', () => {
    const bad = {
      ...validManifest,
      branding: { name: { en: 'Demo' } },
    };
    const result = validateImSettingsManifest(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects when two fields share the same envKey', () => {
    const bad = {
      ...validManifest,
      fields: [
        validManifest.fields[0],
        {
          name: 'token2',
          kind: 'text',
          label: { en: 'Token 2', zh: 'Token 2' },
          envKey: 'GOLDPAN_IM_DEMO_TOKEN', // duplicate
        },
      ],
    };
    const result = validateImSettingsManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toContain('duplicate envKey');
    }
  });
});
