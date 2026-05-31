// Example collector plugin skeleton. The collector echoes its input URL
// back as markdown — no real network IO. CollectorPlugin owns three things:
//   - canHandle(input): is this URL one we want?
//   - priority: higher number wins when multiple collectors match
//   - collect(input, signal): returns content + title + finalUrl + metadata
// settingsContribution is optional; included here to show the protocol.

import type {
  CollectorInput,
  CollectorOutput,
  CollectorPlugin,
  PluginSettingsContribution,
} from '@goldpan/core/plugins';
import { z } from 'zod';

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'collector-noop',
  group: 'collect',
  branding: {
    name: { en: 'Noop Collector', zh: '空 Collector' },
    tagline: { en: 'Echoes URL as markdown', zh: '把 URL 原样转 markdown' },
  },
  schema: z.object({
    enabled: z.boolean().optional(),
  }),
  fields: [
    {
      name: 'enabled',
      kind: 'toggle',
      envKey: 'GOLDPAN_NOOP_COLLECTOR_ENABLED',
      label: { en: 'Enabled', zh: '启用' },
      default: true,
    },
  ],
};

export const goldpanPlugin: CollectorPlugin = {
  name: 'collector-noop',
  version: '0.0.1',
  type: 'collector',
  description: 'Example collector — echoes URL as markdown',
  priority: -100,
  settingsContribution,
  canHandle: (input: CollectorInput) => input.url.startsWith('noop://'),
  collect: async (input: CollectorInput): Promise<CollectorOutput> => ({
    content: `# Noop\n\nURL was: ${input.url}\n`,
    title: 'Noop result',
    metadata: { collector_kind: 'noop' },
    finalUrl: input.url,
  }),
};
