import type {
  PluginActionContext,
  PluginActionHandler,
  PluginContext,
  PluginSettingsContribution,
  ToolPlugin,
} from '@goldpan/core/plugins';
import {
  SEARCH_TIME_RANGE_QDR,
  type SearchOutput,
  searchInputSchema,
  searchOutputSchema,
} from '@goldpan/core/plugins';
import { z } from 'zod';

const SERPER_API_URL = 'https://google.serper.dev/search';

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'tool-search-serper',
  group: 'search',
  branding: { name: 'Serper' },
  enable: {
    envKey: 'GOLDPAN_SERPER_SEARCH_ENABLED',
    label: { en: 'Enable Serper search', zh: '启用 Serper 搜索' },
    default: false,
  },
  schema: z.object({ apiKey: z.string().optional() }),
  fields: [
    {
      name: 'apiKey',
      kind: 'secret',
      envKey: 'SERPER_API_KEY',
      label: { en: 'API Key', zh: 'API Key' },
      placeholder: { en: 'serper key', zh: 'serper key' },
      hint: {
        en: 'Google SERP proxy · supports site: and other advanced operators · ~$0.001 / query',
        zh: 'Google SERP 代理 · 支持 site: 等高级 operator · ~$0.001 / query',
      },
    },
  ],
  actions: [
    {
      id: 'test',
      kind: 'test',
      label: { en: 'Test connection', zh: '测试连接' },
      requires: ['apiKey'],
      errorMessages: {
        no_api_key: { en: 'API key not set', zh: '未配置 API Key' },
        unauthorized: { en: 'Invalid API key', zh: 'API Key 无效' },
        network_error: { en: 'Cannot reach Serper API', zh: '无法访问 Serper API' },
        rate_limited: { en: 'Serper rate limit hit', zh: '触发 Serper 限流' },
      },
    },
  ],
};

const testAction: PluginActionHandler = async (ctx: PluginActionContext) => {
  const apiKey = String(ctx.values.apiKey ?? '');
  if (apiKey.length === 0) return { ok: false, code: 'no_api_key' };
  try {
    const res = await fetch(SERPER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ q: 'ping', num: 1 }),
      signal: ctx.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized' };
    if (res.status === 429) return { ok: false, code: 'rate_limited' };
    if (!res.ok) return { ok: false, code: 'network_error' };
    return { ok: true };
  } catch {
    return { ok: false, code: 'network_error' };
  }
};

// Tools 一律注册，executeTool 时读 process.env，配合 ConfigStore.commit 同步
// 更新 process.env 的机制，API key 改 / 重填 / 首次填都立即生效，无需重启。
export const goldpanPlugin: ToolPlugin = {
  name: 'tool-search-serper',
  version: '0.1.0',
  type: 'tool',
  description: 'Serper API-based Google search tool',
  descriptions: { zh: '基于 Serper API 的 Google 搜索工具' },
  priority: 15,
  tools: [
    {
      name: 'search',
      description: 'Web search via Serper API',
      inputSchema: searchInputSchema,
      outputSchema: searchOutputSchema,
    },
  ],
  settingsContribution,
  settingsActionHandlers: { test: testAction },

  async initialize(_context: PluginContext): Promise<void> {
    // No-op: tools registered statically above. Key check 推迟到 executeTool。
  },

  async executeTool(toolName: string, input: unknown, signal?: AbortSignal): Promise<SearchOutput> {
    if (toolName !== 'search') throw new Error(`Unknown tool: ${toolName}`);
    if (process.env.GOLDPAN_SERPER_SEARCH_ENABLED !== 'true') {
      throw new Error('Serper search disabled (set GOLDPAN_SERPER_SEARCH_ENABLED=true to enable)');
    }
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) throw new Error('Serper API key not configured');

    const parsed = searchInputSchema.parse(input);
    const response = await fetch(SERPER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify({
        q: parsed.query,
        num: parsed.maxResults ?? 10,
        ...(parsed.timeRange && parsed.timeRange !== 'any'
          ? { tbs: `qdr:${SEARCH_TIME_RANGE_QDR[parsed.timeRange]}` }
          : {}),
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Serper API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      organic: Array<{ title: string; link: string; snippet: string; date?: string }>;
    };

    return {
      results: (data.organic ?? []).map((r) => ({
        url: r.link,
        title: r.title,
        snippet: r.snippet,
        ...(r.date ? { publishedAt: r.date } : {}),
      })),
      searchEngine: 'serper',
    };
  },
};
