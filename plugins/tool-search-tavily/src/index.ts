import type {
  PluginActionContext,
  PluginActionHandler,
  PluginContext,
  PluginSettingsContribution,
  ToolPlugin,
} from '@goldpan/core/plugins';
import { type SearchOutput, searchInputSchema, searchOutputSchema } from '@goldpan/core/plugins';
import { z } from 'zod';

const TAVILY_API_URL = 'https://api.tavily.com/search';

// Tavily 接受 day/week/month/year 完整字符串（不是 Google 风格的 d/w/m 短码），
// 所以这里直接用 timeRange，不走 SEARCH_TIME_RANGE_QDR.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const tavilyInputSchema = searchInputSchema.extend({
  includeDomains: z.array(z.string().min(1)).max(150).optional(),
  excludeDomains: z.array(z.string().min(1)).max(150).optional(),
  startDate: z.string().regex(DATE_RE, 'Expected YYYY-MM-DD').optional(),
  endDate: z.string().regex(DATE_RE, 'Expected YYYY-MM-DD').optional(),
});

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'tool-search-tavily',
  group: 'search',
  branding: { name: 'Tavily' },
  enable: {
    envKey: 'GOLDPAN_TAVILY_SEARCH_ENABLED',
    label: { en: 'Enable Tavily search', zh: '启用 Tavily 搜索' },
    default: false,
  },
  schema: z.object({
    apiKey: z.string().optional(),
  }),
  fields: [
    {
      name: 'apiKey',
      kind: 'secret',
      envKey: 'TAVILY_API_KEY',
      label: { en: 'API Key', zh: 'API Key' },
      placeholder: { en: 'tvly-...', zh: 'tvly-...' },
      hint: {
        en: 'General web · LLM-friendly summaries · ~$0.01 / query',
        zh: '通用 web · LLM-friendly summary · ~$0.01 / query',
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
        network_error: { en: 'Cannot reach Tavily API', zh: '无法访问 Tavily API' },
        rate_limited: { en: 'Tavily rate limit hit', zh: '触发 Tavily 限流' },
        internal: { en: 'Internal error', zh: '内部错误' },
      },
    },
  ],
};

const testAction: PluginActionHandler = async (ctx: PluginActionContext) => {
  const apiKey = String(ctx.values.apiKey ?? '');
  if (apiKey.length === 0) return { ok: false, code: 'no_api_key' };
  try {
    const res = await fetch(TAVILY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query: 'ping', max_results: 1 }),
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

// Tools 一律注册，不基于 boot 时 env 状态决定。executeTool 时读 process.env，
// 配合 ConfigStore.commit 同步更新 process.env 的机制，API key 改 / 重填 /
// 首次填都立即生效，无需重启。
export const goldpanPlugin: ToolPlugin = {
  name: 'tool-search-tavily',
  version: '0.1.0',
  type: 'tool',
  description: 'Tavily API-based web search tool',
  descriptions: { zh: '基于 Tavily API 的网页搜索工具' },
  priority: 20,
  tools: [
    {
      name: 'search',
      description:
        'Web search via Tavily API. Supports includeDomains / excludeDomains (max 150 each) and startDate / endDate (YYYY-MM-DD) on top of the shared search input.',
      inputSchema: tavilyInputSchema,
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
    if (process.env.GOLDPAN_TAVILY_SEARCH_ENABLED !== 'true') {
      throw new Error('Tavily search disabled (set GOLDPAN_TAVILY_SEARCH_ENABLED=true to enable)');
    }
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error('Tavily API key not configured');

    const parsed = tavilyInputSchema.parse(input);
    const payload: Record<string, unknown> = {
      api_key: apiKey,
      query: parsed.query,
      search_depth: 'basic',
      max_results: parsed.maxResults ?? 10,
      include_answer: false,
    };
    if (parsed.timeRange && parsed.timeRange !== 'any') {
      payload.time_range = parsed.timeRange;
    }
    if (parsed.startDate) payload.start_date = parsed.startDate;
    if (parsed.endDate) payload.end_date = parsed.endDate;
    if (parsed.includeDomains?.length) payload.include_domains = parsed.includeDomains;
    if (parsed.excludeDomains?.length) payload.exclude_domains = parsed.excludeDomains;

    const response = await fetch(TAVILY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      results: Array<{ url: string; title: string; content: string; published_date?: string }>;
    };

    return {
      results: data.results.map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.content,
        ...(r.published_date ? { publishedAt: r.published_date } : {}),
      })),
      searchEngine: 'tavily',
    };
  },
};
