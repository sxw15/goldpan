import type {
  PluginActionContext,
  PluginActionHandler,
  PluginContext,
  PluginSettingsContribution,
  ToolPlugin,
} from '@goldpan/core/plugins';
import { type SearchOutput, searchInputSchema, searchOutputSchema } from '@goldpan/core/plugins';
import { z } from 'zod';

interface ParsedSearchInput {
  query: string;
  maxResults: number;
  language?: string;
  timeRange: 'any' | 'day' | 'week' | 'month';
}

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

// Brave 用 freshness=pd/pw/pm/py 过滤，与 timeRange 一一对应。
const TIME_RANGE_FRESHNESS: Record<'day' | 'week' | 'month', string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
};

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'tool-search-brave',
  group: 'search',
  branding: { name: { en: 'Brave Search', zh: 'Brave Search' } },
  enable: {
    envKey: 'GOLDPAN_BRAVE_SEARCH_ENABLED',
    label: { en: 'Enable Brave search', zh: '启用 Brave 搜索' },
    default: false,
  },
  schema: z.object({ apiKey: z.string().optional() }),
  fields: [
    {
      name: 'apiKey',
      kind: 'secret',
      envKey: 'BRAVE_SEARCH_API_KEY',
      label: { en: 'Subscription Token', zh: 'Subscription Token' },
      placeholder: { en: 'Brave Subscription Token', zh: 'Brave Subscription Token' },
      hint: {
        en: 'Supports site: operator · privacy-first · free tier (rate limited)',
        zh: '支持 site: operator · 强调隐私 · 免费配额（限速）',
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
        no_api_key: { en: 'Token not set', zh: '未配置 Token' },
        unauthorized: { en: 'Invalid token', zh: 'Token 无效' },
        network_error: { en: 'Cannot reach Brave Search API', zh: '无法访问 Brave Search API' },
        rate_limited: { en: 'Brave rate limit hit', zh: '触发 Brave 限流' },
      },
    },
  ],
};

const testAction: PluginActionHandler = async (ctx: PluginActionContext) => {
  const apiKey = String(ctx.values.apiKey ?? '');
  if (apiKey.length === 0) return { ok: false, code: 'no_api_key' };
  try {
    const res = await fetch(`${BRAVE_API_URL}?q=ping&count=1`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
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
  name: 'tool-search-brave',
  version: '0.1.0',
  type: 'tool',
  description: 'Brave Search API-based web search tool',
  descriptions: { zh: '基于 Brave Search API 的网页搜索工具' },
  priority: 12,
  tools: [
    {
      name: 'search',
      description: 'Web search via Brave Search API',
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
    if (process.env.GOLDPAN_BRAVE_SEARCH_ENABLED !== 'true') {
      throw new Error('Brave search disabled (set GOLDPAN_BRAVE_SEARCH_ENABLED=true to enable)');
    }
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) throw new Error('Brave Search API key not configured');

    const parsed: ParsedSearchInput = searchInputSchema.parse(input) as ParsedSearchInput;
    const count = Math.min(parsed.maxResults ?? 10, 20);
    const params = new URLSearchParams({
      q: parsed.query,
      count: String(count),
    });
    const tr = parsed.timeRange;
    if (tr === 'day' || tr === 'week' || tr === 'month') {
      params.set('freshness', TIME_RANGE_FRESHNESS[tr]);
    }
    if (parsed.language) {
      params.set('search_lang', parsed.language.slice(0, 2).toLowerCase());
    }

    const response = await fetch(`${BRAVE_API_URL}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          url: string;
          title?: string;
          description?: string;
          page_age?: string;
        }>;
      };
    };

    const results = data.web?.results ?? [];
    return {
      results: results.map((r) => ({
        url: r.url,
        title: r.title ?? r.url,
        snippet: r.description ?? '',
        ...(r.page_age ? { publishedAt: r.page_age } : {}),
      })),
      searchEngine: 'brave',
    };
  },
};
