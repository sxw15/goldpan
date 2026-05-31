import type {
  PluginActionContext,
  PluginActionHandler,
  PluginContext,
  PluginSettingsContribution,
  ToolPlugin,
} from '@goldpan/core/plugins';
import { type SearchOutput, searchInputSchema, searchOutputSchema } from '@goldpan/core/plugins';
import { z } from 'zod';

const EXA_API_URL = 'https://api.exa.ai/search';

// Exa 没有 qdr/d|w|m 这种短码，按 startPublishedDate (ISO) 过滤。
const TIME_RANGE_DAYS: Record<'day' | 'week' | 'month', number> = {
  day: 1,
  week: 7,
  month: 30,
};

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const exaInputSchema = searchInputSchema.extend({
  includeDomains: z.array(z.string().min(1)).max(1200).optional(),
  excludeDomains: z.array(z.string().min(1)).max(1200).optional(),
  startPublishedDate: z
    .string()
    .regex(ISO_DATETIME_RE, 'Expected ISO 8601 datetime, e.g. 2024-01-01T00:00:00Z')
    .optional(),
  endPublishedDate: z
    .string()
    .regex(ISO_DATETIME_RE, 'Expected ISO 8601 datetime, e.g. 2024-01-01T00:00:00Z')
    .optional(),
});

function timeRangeToStartDate(range: 'day' | 'week' | 'month', now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - TIME_RANGE_DAYS[range]);
  return d.toISOString();
}

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'tool-search-exa',
  group: 'search',
  branding: { name: 'Exa' },
  enable: {
    envKey: 'GOLDPAN_EXA_SEARCH_ENABLED',
    label: { en: 'Enable Exa search', zh: '启用 Exa 搜索' },
    default: false,
  },
  schema: z.object({ apiKey: z.string().optional() }),
  fields: [
    {
      name: 'apiKey',
      kind: 'secret',
      envKey: 'EXA_API_KEY',
      label: { en: 'API Key', zh: 'API Key' },
      placeholder: { en: 'exa key', zh: 'exa key' },
      hint: {
        en: 'Semantic search · long-form & academic friendly · ~$0.005 / query',
        zh: '语义检索 · 长文 / 论文友好 · ~$0.005 / query',
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
        network_error: { en: 'Cannot reach Exa API', zh: '无法访问 Exa API' },
        rate_limited: { en: 'Exa rate limit hit', zh: '触发 Exa 限流' },
      },
    },
  ],
};

const testAction: PluginActionHandler = async (ctx: PluginActionContext) => {
  const apiKey = String(ctx.values.apiKey ?? '');
  if (apiKey.length === 0) return { ok: false, code: 'no_api_key' };
  try {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ query: 'ping', numResults: 1 }),
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
  name: 'tool-search-exa',
  version: '0.1.0',
  type: 'tool',
  description: 'Exa API-based semantic web search tool',
  descriptions: { zh: '基于 Exa API 的语义网页搜索工具' },
  priority: 18,
  tools: [
    {
      name: 'search',
      description:
        'Web search via Exa API (semantic / neural). Supports includeDomains / excludeDomains (max 1200 each, with subdomain wildcards & URL-path filtering) and startPublishedDate / endPublishedDate (ISO 8601) on top of the shared search input.',
      inputSchema: exaInputSchema,
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
    if (process.env.GOLDPAN_EXA_SEARCH_ENABLED !== 'true') {
      throw new Error('Exa search disabled (set GOLDPAN_EXA_SEARCH_ENABLED=true to enable)');
    }
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) throw new Error('Exa API key not configured');

    const parsed = exaInputSchema.parse(input);
    // 显式 startPublishedDate 优先于 timeRange 派生的日期。
    const derivedStart =
      parsed.timeRange && parsed.timeRange !== 'any'
        ? timeRangeToStartDate(parsed.timeRange)
        : undefined;
    const payload: Record<string, unknown> = {
      query: parsed.query,
      numResults: parsed.maxResults ?? 10,
      type: 'auto',
      contents: { text: { maxCharacters: 500 } },
    };
    const startDate = parsed.startPublishedDate ?? derivedStart;
    if (startDate) payload.startPublishedDate = startDate;
    if (parsed.endPublishedDate) payload.endPublishedDate = parsed.endPublishedDate;
    if (parsed.includeDomains?.length) payload.includeDomains = parsed.includeDomains;
    if (parsed.excludeDomains?.length) payload.excludeDomains = parsed.excludeDomains;

    const response = await fetch(EXA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Exa API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      results: Array<{
        url: string;
        title?: string | null;
        text?: string;
        publishedDate?: string;
      }>;
    };

    return {
      results: data.results.map((r) => ({
        url: r.url,
        title: r.title ?? r.url,
        snippet: r.text ?? '',
        ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
      })),
      searchEngine: 'exa',
    };
  },
};
