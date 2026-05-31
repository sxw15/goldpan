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

// SearXNG 用 time_range=day|week|month|year，与 timeRange 直接对齐。
const TIME_RANGE_MAP: Record<'day' | 'week' | 'month', string> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

const searxngBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'SearXNG base URL must use http(s)')
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.search === '' && u.hash === '';
    } catch {
      return false;
    }
  }, 'SearXNG base URL must not include query or hash');

function normalizeBaseUrl(input: string): string {
  return searxngBaseUrlSchema.parse(input).replace(/\/+$/, '');
}

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'tool-search-searxng',
  group: 'search',
  branding: { name: 'SearXNG' },
  enable: {
    envKey: 'GOLDPAN_SEARXNG_SEARCH_ENABLED',
    label: { en: 'Enable SearXNG search', zh: '启用 SearXNG 搜索' },
    default: false,
  },
  schema: z.object({
    baseUrl: z.preprocess(
      (value) => (value === '' ? undefined : value),
      searxngBaseUrlSchema.optional(),
    ),
  }),
  fields: [
    {
      name: 'baseUrl',
      kind: 'text',
      envKey: 'SEARXNG_BASE_URL',
      label: { en: 'Base URL', zh: 'Base URL' },
      required: true,
      placeholder: { en: 'https://searx.example.com', zh: 'https://searx.example.com' },
      hint: {
        en: 'Self-hosted meta-search · multi-source aggregation · no cost',
        zh: '自托管 meta-search · 多源聚合 · 不计费',
      },
    },
  ],
  actions: [
    {
      id: 'test',
      kind: 'test',
      label: { en: 'Test connection', zh: '测试连接' },
      requires: ['baseUrl'],
      errorMessages: {
        no_base_url: { en: 'Base URL not set', zh: '未配置 Base URL' },
        bad_response: { en: 'SearXNG returned an error', zh: 'SearXNG 返回错误' },
        network_error: { en: 'Cannot reach SearXNG', zh: '无法访问 SearXNG' },
      },
    },
  ],
};

const testAction: PluginActionHandler = async (ctx: PluginActionContext) => {
  const baseUrl = String(ctx.values.baseUrl ?? '');
  if (baseUrl.length === 0) return { ok: false, code: 'no_base_url' };
  try {
    const url = `${normalizeBaseUrl(baseUrl)}/search?q=ping&format=json`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ctx.signal,
    });
    if (!res.ok) return { ok: false, code: 'bad_response' };
    return { ok: true };
  } catch {
    return { ok: false, code: 'network_error' };
  }
};

// Tools 一律注册，executeTool 时读 process.env，配合 ConfigStore.commit 同步
// 更新 process.env 的机制，base URL 改 / 首次填都立即生效，无需重启。
export const goldpanPlugin: ToolPlugin = {
  name: 'tool-search-searxng',
  version: '0.1.0',
  type: 'tool',
  description: 'SearXNG self-hosted meta-search engine',
  descriptions: { zh: '基于自托管 SearXNG 的聚合搜索引擎' },
  priority: 8,
  tools: [
    {
      name: 'search',
      description: 'Web search via self-hosted SearXNG instance (JSON API)',
      inputSchema: searchInputSchema,
      outputSchema: searchOutputSchema,
    },
  ],
  settingsContribution,
  settingsActionHandlers: { test: testAction },

  async initialize(_context: PluginContext): Promise<void> {
    // No-op: tools registered statically above. URL check 推迟到 executeTool。
  },

  async executeTool(toolName: string, input: unknown, signal?: AbortSignal): Promise<SearchOutput> {
    if (toolName !== 'search') throw new Error(`Unknown tool: ${toolName}`);
    if (process.env.GOLDPAN_SEARXNG_SEARCH_ENABLED !== 'true') {
      throw new Error(
        'SearXNG search disabled (set GOLDPAN_SEARXNG_SEARCH_ENABLED=true to enable)',
      );
    }
    const raw = process.env.SEARXNG_BASE_URL;
    if (!raw) throw new Error('SearXNG base URL not configured');
    const baseUrl = normalizeBaseUrl(raw);

    const parsed: ParsedSearchInput = searchInputSchema.parse(input) as ParsedSearchInput;
    const params = new URLSearchParams({
      q: parsed.query,
      format: 'json',
    });
    const tr = parsed.timeRange;
    if (tr === 'day' || tr === 'week' || tr === 'month') {
      params.set('time_range', TIME_RANGE_MAP[tr]);
    }
    if (parsed.language) {
      params.set('language', parsed.language);
    }

    const response = await fetch(`${baseUrl}/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });

    if (!response.ok) {
      throw new Error(`SearXNG error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      results?: Array<{
        url: string;
        title?: string;
        content?: string;
        publishedDate?: string;
      }>;
    };

    // SearXNG 不支持 maxResults 参数 —— 它一次返回一页（默认 ~10 条），需要
    // 客户端裁剪。给 maxResults 一个 cap 避免超出 schema 上限。
    const max = parsed.maxResults ?? 10;
    const results = (data.results ?? []).slice(0, max);
    return {
      results: results.map((r) => ({
        url: r.url,
        title: r.title ?? r.url,
        snippet: r.content ?? '',
        ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
      })),
      searchEngine: 'searxng',
    };
  },
};
