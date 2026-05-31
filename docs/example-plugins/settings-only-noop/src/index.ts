// Example "settings-only" plugin skeleton. Demonstrates the full
// PluginSettingsContribution surface — fields (text + secret), action
// (with requires + errorMessages), and setupGuide step — without any
// runtime behavior. Useful as a starting point when the user-facing piece
// of a plugin is just configuration / a smoke-test button.
//
// Implemented as a ToolPlugin with `tools: []` because every settings
// contribution still needs a host GoldpanPlugin to attach to. executeTool
// throws because there are no tools declared.

import type {
  PluginActionHandler,
  PluginSettingsContribution,
  ToolPlugin,
} from '@goldpan/core/plugins';
import { z } from 'zod';

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'settings-only-noop',
  group: 'search',
  branding: {
    name: { en: 'Settings-only Demo', zh: 'Settings-only 演示' },
    tagline: {
      en: 'Shows fields / action / setupGuide without runtime',
      zh: '演示 fields / action / setupGuide，不带运行时',
    },
  },
  schema: z.object({
    apiKey: z.string().optional(),
    nickname: z.string().optional(),
  }),
  fields: [
    {
      name: 'apiKey',
      kind: 'secret',
      envKey: 'GOLDPAN_DEMO_API_KEY',
      label: { en: 'Demo API key', zh: '演示 API Key' },
      placeholder: 'demo-...',
      required: false,
    },
    {
      name: 'nickname',
      kind: 'text',
      envKey: 'GOLDPAN_DEMO_NICKNAME',
      label: { en: 'Display nickname', zh: '显示昵称' },
      placeholder: { en: 'My name', zh: '我的昵称' },
    },
  ],
  actions: [
    {
      id: 'test',
      kind: 'test',
      label: { en: 'Echo test', zh: '回显测试' },
      requires: ['apiKey'],
      errorMessages: {
        no_api_key: { en: 'API key empty', zh: 'API key 为空' },
      },
    },
  ],
  setupGuide: {
    steps: [
      {
        id: 'intro',
        title: { en: 'Read the authoring guide', zh: '读一遍 authoring guide' },
        desc: {
          en: 'Open the doc to learn how each field, action, and step works.',
          zh: '打开文档了解每个字段、action、step 的含义。',
        },
      },
    ],
  },
};

const echoAction: PluginActionHandler = async (ctx) => {
  const apiKey = String(ctx.values.apiKey ?? '');
  if (apiKey.length === 0) return { ok: false, code: 'no_api_key' };
  return { ok: true };
};

export const goldpanPlugin: ToolPlugin = {
  name: 'settings-only-noop',
  version: '0.0.1',
  type: 'tool',
  description: 'Settings-only example plugin (no runtime behavior).',
  priority: -100,
  tools: [],
  settingsContribution,
  settingsActionHandlers: { test: echoAction },
  async initialize() {},
  async executeTool(): Promise<never> {
    throw new Error('settings-only-noop has no tools');
  },
};
