// Example search tool plugin skeleton. Returns one canned result regardless
// of query. Real search plugins wrap an external API (Tavily / Serper /
// Brave / etc.) and pull credentials out of the contribution's env keys.
//
// `priority` decides which search engine the registry tries first when
// multiple plugins offer the `search` capability. Higher wins.

import type {
  PluginContext,
  PluginSettingsContribution,
  SearchOutput,
  ToolPlugin,
} from '@goldpan/core/plugins';
import { searchInputSchema, searchOutputSchema } from '@goldpan/core/plugins';
import { z } from 'zod';

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'tool-search-noop',
  group: 'search',
  branding: {
    name: 'Noop Search',
    tagline: { en: 'Returns canned results', zh: '返回固定结果' },
  },
  schema: z.object({}),
  fields: [],
};

export const goldpanPlugin: ToolPlugin = {
  name: 'tool-search-noop',
  version: '0.0.1',
  type: 'tool',
  description: 'Example search tool — returns fixed results',
  priority: -100,
  tools: [
    {
      name: 'search',
      description: 'Returns one canned result regardless of query.',
      inputSchema: searchInputSchema,
      outputSchema: searchOutputSchema,
    },
  ],
  settingsContribution,
  async initialize(_ctx: PluginContext) {},
  async executeTool(toolName: string, input: unknown): Promise<SearchOutput> {
    if (toolName !== 'search') throw new Error(`Unknown tool: ${toolName}`);
    const parsed = searchInputSchema.parse(input);
    return {
      results: [
        {
          url: 'https://example.com/noop',
          title: 'Noop result',
          snippet: `Echo of query: ${parsed.query}`,
        },
      ],
      searchEngine: 'noop',
    };
  },
};
