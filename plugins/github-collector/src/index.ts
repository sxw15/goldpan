import { sources } from '@goldpan/core/db/schema';
import type {
  CollectorInput,
  CollectorOutput,
  CollectorPlugin,
  PluginActionContext,
  PluginActionHandler,
  PluginContext,
  PluginSettingsContribution,
  ServiceCapabilities,
} from '@goldpan/core/plugins';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { GithubApiClient } from './api.js';
import { createGithubCollector } from './collector.js';
import { GithubService } from './service.js';

export type {
  EntitySourceRow,
  GithubRepoSummary,
  GithubService,
  RefreshResult,
  RepoState,
} from './service.js';

let apiClient: GithubApiClient | undefined;
let service: GithubService | undefined;
let activeCollector: CollectorPlugin | undefined;

const envSchema = z.object({
  token: z.string().optional(),
  apiBase: z.string().default('https://api.github.com'),
  timeoutSec: z.coerce.number().int().positive().default(15),
  commitsLimit: z.coerce.number().int().positive().default(20),
  releasesLimit: z.coerce.number().int().positive().default(10),
  // Undefined falls back to GOLDPAN_MAX_CONTENT_LENGTH (core) — see initialize().
  // A plugin-local default here would silently override core and trip
  // content_too_long for any repo whose stitched content exceeds the core cap.
  maxContentLength: z.coerce.number().int().positive().optional(),
  refreshMinIntervalSec: z.coerce.number().int().positive().default(60),
  cleanReadme: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
});

export function parseEnv(env: NodeJS.ProcessEnv = process.env) {
  return envSchema.parse({
    token: env.GOLDPAN_GITHUB_TOKEN,
    apiBase: env.GOLDPAN_GITHUB_API_BASE,
    timeoutSec: env.GOLDPAN_GITHUB_HTTP_TIMEOUT_SEC,
    commitsLimit: env.GOLDPAN_GITHUB_RECENT_COMMITS_LIMIT,
    releasesLimit: env.GOLDPAN_GITHUB_RECENT_RELEASES_LIMIT,
    maxContentLength: env.GOLDPAN_GITHUB_MAX_CONTENT_LENGTH,
    refreshMinIntervalSec: env.GOLDPAN_GITHUB_REFRESH_MIN_INTERVAL_SEC,
    cleanReadme: env.GOLDPAN_GITHUB_README_CLEAN,
  });
}

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'collector-github',
  group: 'collect',
  branding: {
    name: { en: 'GitHub Collector', zh: 'GitHub 抓取' },
    tagline: { en: 'Repos, issues, PRs', zh: '仓库 / Issue / PR' },
    // homepage intentionally omitted — the canonical public URL is not yet
    // decided, and pointing at a private repo would 404 for non-members.
  },
  schema: z.object({
    token: z.string().optional(),
  }),
  fields: [
    {
      name: 'token',
      kind: 'secret',
      envKey: 'GOLDPAN_GITHUB_TOKEN',
      label: { en: 'Personal Access Token', zh: 'Personal Access Token' },
      placeholder: { en: 'ghp_...', zh: 'ghp_...' },
      hint: {
        en: 'Classic or fine-grained PAT. Read-only scopes are sufficient.',
        zh: '经典或细粒度 PAT。只读权限即可。',
      },
      requiresRestart: true,
    },
  ],
  actions: [
    {
      id: 'test',
      kind: 'test',
      label: { en: 'Test token', zh: '测试 token' },
      requires: ['token'],
      errorMessages: {
        no_token: { en: 'Token not configured', zh: '未配置 token' },
        unauthorized: { en: 'Invalid token', zh: 'Token 无效' },
        rate_limited: { en: 'GitHub rate limit hit', zh: '触发 GitHub 限流' },
        network_error: { en: 'Cannot reach GitHub API', zh: '无法访问 GitHub API' },
      },
    },
  ],
  setupGuide: {
    allDoneTitle: { en: 'GitHub access ready', zh: '已完成 GitHub 接入' },
    steps: [
      {
        id: 'create_pat',
        title: { en: 'Create a Personal Access Token', zh: '创建 Personal Access Token' },
        desc: {
          en: 'Open github.com/settings/tokens. Use "Classic" or "Fine-grained" — both work. Read-only repo scope is enough for public + private read.',
          zh: '打开 github.com/settings/tokens,创建 Classic 或 Fine-grained PAT。只读 repo 权限即可读取公开 + 私有仓库。',
        },
        externalLink: {
          label: { en: 'Open GitHub tokens page', zh: '打开 GitHub tokens 页' },
          href: 'https://github.com/settings/tokens',
        },
      },
      {
        id: 'select_scopes',
        title: { en: 'Pick the right scopes', zh: '选对权限' },
        desc: {
          en: 'Check "repo" (or "Contents: read" for fine-grained). Add "read:org" if you want to index private organization repos.',
          zh: '勾选 "repo"(细粒度则勾 Contents: read)。若需读私有组织仓库,加 "read:org"。',
        },
      },
      {
        id: 'paste',
        title: { en: 'Paste it above and save', zh: '把 token 填到上方并保存' },
        desc: {
          en: 'Copy the token immediately after creation — GitHub never shows it again. Paste it into the Personal Access Token field above.',
          zh: '创建后立即复制 — GitHub 不再二次显示。把它填入上方 Personal Access Token 字段并保存。',
        },
      },
    ],
  },
};

const testAction: PluginActionHandler = async (ctx: PluginActionContext) => {
  const token = String(ctx.values.token ?? '');
  if (token.length === 0) return { ok: false, code: 'no_token' };
  // Honor GOLDPAN_GITHUB_API_BASE so GitHub Enterprise installs verify the
  // token against the same host the collector actually calls (parseEnv()
  // reads the same var). Trailing slash is stripped to keep the joined URL
  // tidy across user-typed values like `https://ghe.example.com/api/v3/`.
  const apiBase = (process.env.GOLDPAN_GITHUB_API_BASE || 'https://api.github.com').replace(
    /\/+$/,
    '',
  );
  try {
    const res = await fetch(`${apiBase}/user`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'goldpan' },
      signal: ctx.signal,
    });
    if (res.status === 401) return { ok: false, code: 'unauthorized' };
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') return { ok: false, code: 'rate_limited' };
      return { ok: false, code: 'unauthorized' };
    }
    if (!res.ok) return { ok: false, code: 'network_error' };
    return { ok: true };
  } catch {
    return { ok: false, code: 'network_error' };
  }
};

export const goldpanPlugin: CollectorPlugin = {
  name: 'collector-github',
  type: 'collector',
  version: '0.1.0',
  description: 'GitHub repository collector (README + releases + commits + CHANGELOG)',
  descriptions: { zh: 'GitHub 仓库采集器（README + releases + commits + CHANGELOG）' },
  settingsContribution,
  settingsActionHandlers: { test: testAction },
  priority: 20,
  requiredCapabilities: ['db', 'pluginRegistry', 'config'],

  async initialize(_context: PluginContext, capabilities?: Partial<ServiceCapabilities>) {
    const db = capabilities?.db;
    const pluginRegistry = capabilities?.pluginRegistry;
    const coreConfig = capabilities?.config;
    if (!db || !pluginRegistry || !coreConfig) {
      throw new Error('collector-github requires db + pluginRegistry + config capabilities');
    }
    const env = parseEnv();
    if (!env.token) {
      console.warn('[github-collector] GOLDPAN_GITHUB_TOKEN unset — limited to 60 req/h');
    }
    apiClient = new GithubApiClient({
      token: env.token,
      apiBase: env.apiBase,
      timeoutMs: env.timeoutSec * 1000,
    });

    const dbLookup = {
      async getLatestConfirmed(normalizedUrl: string) {
        const row = db
          .select({ metadata: sources.metadata })
          .from(sources)
          .where(
            and(
              eq(sources.normalizedUrl, normalizedUrl),
              inArray(sources.status, ['confirmed', 'confirmed_empty']),
            ),
          )
          .orderBy(desc(sources.id))
          .limit(1)
          .get();
        if (!row?.metadata) return null;
        return { metadata: JSON.parse(row.metadata) as Record<string, unknown> };
      },
    };

    service = new GithubService({ db, cooldownSec: env.refreshMinIntervalSec });
    pluginRegistry.registerService('github', service);

    activeCollector = createGithubCollector({
      apiClient,
      config: {
        token: env.token,
        apiBase: env.apiBase,
        timeoutMs: env.timeoutSec * 1000,
        commitsLimit: env.commitsLimit,
        releasesLimit: env.releasesLimit,
        maxContentLength: env.maxContentLength ?? coreConfig.maxContentLength,
        cleanReadme: env.cleanReadme,
      },
      dbLookup,
    });
  },

  async destroy() {
    apiClient = undefined;
    service = undefined;
    activeCollector = undefined;
  },

  canHandle(input: CollectorInput): boolean | Promise<boolean> {
    return activeCollector ? activeCollector.canHandle(input) : false;
  },
  async collect(input: CollectorInput, signal: AbortSignal): Promise<CollectorOutput> {
    if (!activeCollector) {
      throw new Error('collector-github not initialized — bootstrap did not call initialize()');
    }
    return activeCollector.collect(input, signal);
  },
};
