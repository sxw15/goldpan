import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  PluginActionContext,
  PluginActionHandler,
  PluginContext,
  PluginSettingsContribution,
  ServiceCapabilities,
  ToolPlugin,
} from '@goldpan/core/plugins';
import {
  SEARCH_TIME_RANGE_QDR,
  type SearchOutput,
  SharedResourceManager,
  searchInputSchema,
  searchOutputSchema,
} from '@goldpan/core/plugins';
import type { Browser } from 'playwright';
import { z } from 'zod';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

const SELECTORS = {
  resultContainer: '#search .g',
  title: 'h3',
  link: 'a[href]',
  snippet: '[data-sncf], .VwiC3b',
  captchaIndicator: '#captcha-form, form[action*="sorry"]',
};

let browserManager: SharedResourceManager<Browser> | null = null;
let hourlyCount = 0;
let hourlyResetAt = 0;
let lastSearchAt = 0;
/**
 * Tracks the headless mode the currently-cached browser was launched with.
 * `null` = no browser yet. `executeTool` compares this against the env to
 * decide whether to destroy + relaunch when the user flips the toggle.
 */
let lastLaunchedHeadless: boolean | null = null;

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Default headed: anti-scrape is the dominant Google failure mode and
// headless triggers CAPTCHA almost on contact. Self-hosted users on a
// desktop should default to a real window; explicit opt-in for headless
// (Docker / server / CI) keeps the dangerous path behind a toggle.
function readHeadlessEnv(): boolean {
  return process.env.GOLDPAN_GOOGLE_SEARCH_HEADLESS === 'true';
}

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'tool-search-google',
  group: 'search',
  branding: { name: 'Google' },
  enable: {
    envKey: 'GOLDPAN_GOOGLE_SEARCH_ENABLED',
    label: { en: 'Enable Google search', zh: '启用 Google 搜索' },
    default: false,
  },
  notices: [
    {
      kind: 'warn',
      message: {
        en: 'Google aggressively blocks automated traffic. Headless requests are almost certain to hit a CAPTCHA, which triggers a 30-minute cooldown on the shared browser. For reliable searches prefer Tavily, Serper, Brave, or Exa first; reserve Google for fallbacks when other providers are unavailable.',
        zh: 'Google 反爬严格,无头模式几乎一定会触发 CAPTCHA(命中后会冻结 30 分钟)。建议优先使用 Tavily / Serper / Brave / Exa 等渠道,Google 作为兜底再启用。',
      },
    },
    {
      kind: 'info',
      message: {
        en: 'First-time use requires the Playwright Chromium binary (~90 MB). Use the "Check / install browser" buttons below to verify or download it.',
        zh: '首次使用前需要本地有 Playwright Chromium 二进制(约 90 MB)。请使用下方的"检查 / 安装浏览器"按钮确认或下载。',
      },
    },
  ],
  schema: z.object({
    headless: z.boolean().optional(),
    hourlyLimit: z.number().int().min(1).max(1000).optional(),
    delayMinMs: z.number().int().min(0).optional(),
    delayMaxMs: z.number().int().min(0).optional(),
  }),
  fields: [
    {
      name: 'headless',
      kind: 'toggle',
      envKey: 'GOLDPAN_GOOGLE_SEARCH_HEADLESS',
      label: { en: 'Headless mode', zh: '无头模式' },
      hint: {
        en: 'Default off — runs a real browser window, which Google CAPTCHA targets less aggressively. Turn on only on a headless server (Docker / CI) where no display is available.',
        zh: '默认关闭 —— 弹出真实浏览器窗口,Google 反爬触发率显著降低。仅在无显示环境(Docker / CI)需要时打开。',
      },
      default: false,
    },
    {
      name: 'hourlyLimit',
      kind: 'number',
      envKey: 'GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT',
      label: { en: 'Hourly limit', zh: '每小时限额' },
      hint: {
        en: 'Max searches per hour (default 20). Higher = more CAPTCHA risk.',
        zh: '每小时最大搜索次数(默认 20)。越高越容易触发 CAPTCHA。',
      },
      placeholder: { en: '20', zh: '20' },
      min: 1,
      max: 1000,
    },
    {
      name: 'delayMinMs',
      kind: 'number',
      envKey: 'GOLDPAN_GOOGLE_SEARCH_DELAY_MIN_MS',
      label: { en: 'Min delay (ms)', zh: '最小延迟 (ms)' },
      hint: {
        en: 'Min wait between searches (default 2000)',
        zh: '两次搜索之间的最小等待(默认 2000)',
      },
      placeholder: { en: '2000', zh: '2000' },
      min: 0,
    },
    {
      name: 'delayMaxMs',
      kind: 'number',
      envKey: 'GOLDPAN_GOOGLE_SEARCH_DELAY_MAX_MS',
      label: { en: 'Max delay (ms)', zh: '最大延迟 (ms)' },
      hint: {
        en: 'Max wait between searches (default 5000)',
        zh: '两次搜索之间的最大等待(默认 5000)',
      },
      placeholder: { en: '5000', zh: '5000' },
      min: 0,
    },
  ],
  actions: [
    {
      id: 'check_browser',
      kind: 'test',
      label: { en: 'Check browser binary', zh: '检查浏览器二进制' },
      errorMessages: {
        not_installed: {
          en: 'Chromium binary not installed — click "Install browser binary" to download (~90 MB).',
          zh: '未检测到 Chromium 二进制 —— 点击"安装浏览器二进制"下载(约 90 MB)。',
        },
        playwright_missing: {
          en: 'Playwright package not loadable on the server',
          zh: '服务端 Playwright 包不可用',
        },
      },
    },
    {
      id: 'install_browser',
      kind: 'test',
      label: { en: 'Install browser binary', zh: '安装浏览器二进制' },
      // 5 minutes — chromium binary is ~90 MB; install may also pull the
      // ffmpeg helper alongside, which can run into a slow CDN.
      timeoutMs: 300_000,
      errorMessages: {
        install_failed: {
          en: 'Browser install failed — check server logs for the playwright stderr',
          zh: '浏览器安装失败 —— 查看服务端日志中的 playwright 错误输出',
        },
        spawn_failed: {
          en: 'Could not spawn the playwright install command',
          zh: '无法启动 playwright install 命令',
        },
      },
    },
  ],
};

async function ensureBrowserMode(): Promise<void> {
  if (!browserManager) return;
  const desired = readHeadlessEnv();
  if (lastLaunchedHeadless === null || lastLaunchedHeadless === desired) return;
  // Mode flipped after the cached browser was launched — destroy without
  // setting a cooldown so the next acquire() launches in the new mode.
  await browserManager.destroy();
  lastLaunchedHeadless = null;
}

const checkBrowserAction: PluginActionHandler = async () => {
  try {
    const { chromium } = await import('playwright');
    const path = chromium.executablePath();
    if (!path) return { ok: false, code: 'not_installed' };
    try {
      await fs.access(path);
      return { ok: true, data: { path } };
    } catch {
      return { ok: false, code: 'not_installed' };
    }
  } catch {
    return { ok: false, code: 'playwright_missing' };
  }
};

const installBrowserAction: PluginActionHandler = async (ctx: PluginActionContext) => {
  // Resolve the playwright CLI inside the package — works regardless of
  // whether the host has `playwright` on PATH (it normally doesn't, since
  // only this plugin depends on it).
  let cliPath: string;
  try {
    const req = (await import('node:module')).createRequire(import.meta.url);
    const packageJsonPath = req.resolve('playwright/package.json');
    const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
      bin?: { playwright?: string };
    };
    const binPath = pkg.bin?.playwright;
    if (typeof binPath !== 'string' || binPath.length === 0) {
      throw new Error('playwright package.json missing bin.playwright');
    }
    cliPath = join(dirname(packageJsonPath), binPath);
  } catch (err) {
    ctx.logger.error('install_browser: cannot resolve Playwright CLI', { err: String(err) });
    return { ok: false, code: 'spawn_failed' };
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      ctx.logger.info(`playwright install: ${chunk.toString().trim()}`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ctx.signal.addEventListener(
      'abort',
      () => {
        child.kill('SIGTERM');
      },
      { once: true },
    );
    child.on('error', (err) => {
      ctx.logger.error('install_browser: spawn error', { err: err.message });
      resolve({ ok: false, code: 'spawn_failed' });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      ctx.logger.error('install_browser: non-zero exit', { code, stderr: stderr.slice(0, 2000) });
      resolve({ ok: false, code: 'install_failed' });
    });
  });
};

// Tools 一律注册,executeTool 时读 process.env,配合 ConfigStore.commit 同步
// 更新 process.env 的机制,enable / headless / 限速参数改了立即生效,无需重启。
export const goldpanPlugin: ToolPlugin = {
  name: 'tool-search-google',
  version: '0.1.0',
  type: 'tool',
  description: 'Google search via Playwright browser (headed by default)',
  descriptions: { zh: '通过 Playwright 浏览器执行 Google 搜索(默认有界面)' },
  priority: 5,
  tools: [
    {
      name: 'search',
      description: 'Web search via Google (Playwright)',
      inputSchema: searchInputSchema,
      outputSchema: searchOutputSchema,
    },
  ],
  requiredCapabilities: ['pluginRegistry'],
  settingsContribution,
  settingsActionHandlers: {
    check_browser: checkBrowserAction,
    install_browser: installBrowserAction,
  },

  async initialize(
    _context: PluginContext,
    capabilities?: Partial<ServiceCapabilities>,
  ): Promise<void> {
    // 一律注册 browser manager —— SharedResourceManager 是 lazy 的(acquire
    // 时才 launch chromium),所以即使 ENABLED=false 也不会真启浏览器。
    // ENABLED / HEADLESS flag 改去 executeTool 时检查,这样改 flag 立即生效。
    const registry = capabilities?.pluginRegistry;
    if (!registry) throw new Error('pluginRegistry capability is required');

    const { chromium } = await import('playwright');
    browserManager = registry.registerService(
      'shared-browser',
      new SharedResourceManager({
        launcher: async () => {
          const headless = readHeadlessEnv();
          const browser = await chromium.launch({ headless });
          lastLaunchedHeadless = headless;
          return browser;
        },
        destroyer: (browser: Browser) => browser.close(),
        cooldownMs: 30 * 60 * 1000,
      }),
    );
  },

  async destroy(): Promise<void> {
    if (browserManager) {
      await browserManager.destroy();
      browserManager = null;
      lastLaunchedHeadless = null;
    }
  },

  async executeTool(toolName: string, input: unknown, signal?: AbortSignal): Promise<SearchOutput> {
    if (toolName !== 'search') throw new Error(`Unknown tool: ${toolName}`);
    if (!browserManager) throw new Error('Google search plugin not initialized');
    if (process.env.GOLDPAN_GOOGLE_SEARCH_ENABLED !== 'true') {
      throw new Error('Google search disabled (set GOLDPAN_GOOGLE_SEARCH_ENABLED=true to enable)');
    }
    if (signal?.aborted) throw new Error('Aborted');

    // Reconcile cached browser's headless mode with current env. Toggling the
    // setting at runtime should take effect on the next search — otherwise
    // the user's setting flip is silently ignored until process restart.
    await ensureBrowserMode();

    // 每次调用读最新 limit / delay env,无需重启即可调整。
    const hourlyLimit = readNumberEnv('GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT', 20);
    const delayMinMs = readNumberEnv('GOLDPAN_GOOGLE_SEARCH_DELAY_MIN_MS', 2000);
    let delayMaxMs = readNumberEnv('GOLDPAN_GOOGLE_SEARCH_DELAY_MAX_MS', 5000);
    if (delayMaxMs < delayMinMs) delayMaxMs = delayMinMs;

    const now = Date.now();
    if (now >= hourlyResetAt) {
      hourlyCount = 0;
      hourlyResetAt = now + 3600_000;
    }
    if (hourlyCount >= hourlyLimit) {
      throw new Error(`Hourly search limit reached (${hourlyLimit})`);
    }

    const timeSinceLast = now - lastSearchAt;
    if (timeSinceLast < delayMinMs) {
      const wait = delayMinMs + Math.random() * (delayMaxMs - delayMinMs) - timeSinceLast;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    const parsed = searchInputSchema.parse(input);
    const browser = await browserManager.acquire();
    const page = await browser.newPage({
      userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    });

    if (signal) {
      signal.addEventListener('abort', () => page.close().catch(() => {}), { once: true });
    }

    try {
      const maxResults = parsed.maxResults ?? 10;
      const tbs =
        parsed.timeRange && parsed.timeRange !== 'any'
          ? `&tbs=qdr:${SEARCH_TIME_RANGE_QDR[parsed.timeRange]}`
          : '';
      const url = `https://www.google.com/search?q=${encodeURIComponent(parsed.query)}&num=${maxResults}${tbs}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });

      const captcha = await page.$(SELECTORS.captchaIndicator);
      if (captcha) {
        await browserManager.destroyWithCooldown();
        lastLaunchedHeadless = null;
        throw new Error('CAPTCHA detected — Google search temporarily unavailable');
      }

      const elements = await page.$$(SELECTORS.resultContainer);
      const results: SearchOutput['results'] = [];
      for (const el of elements.slice(0, maxResults)) {
        const titleEl = await el.$(SELECTORS.title);
        const linkEl = await el.$(SELECTORS.link);
        const snippetEl = await el.$(SELECTORS.snippet);
        const title = (await titleEl?.textContent()) ?? '';
        const href = await linkEl?.getAttribute('href');
        const snippet = (await snippetEl?.textContent()) ?? '';
        if (href?.startsWith('http')) {
          results.push({ url: href, title, snippet });
        }
      }

      hourlyCount++;
      lastSearchAt = Date.now();
      return { results, searchEngine: 'google' };
    } finally {
      await page.close().catch(() => {});
    }
  },
};
