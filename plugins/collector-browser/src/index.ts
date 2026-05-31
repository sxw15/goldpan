import { errorMessage } from '@goldpan/core/errors';
import {
  CollectorError,
  type CollectorInput,
  type CollectorOutput,
  type CollectorPlugin,
  emitCollectDiagnostic,
  formatAbortSignalReason,
  type PluginContext,
  type PluginSettingsContribution,
  parseCollectedHtml,
  validateSsrfIfEnabled,
} from '@goldpan/core/plugins';
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  errors as playwrightErrors,
} from 'playwright';
import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 30_000;

export type BrowserLaunchStrategy = 'auto' | 'bundled' | 'system-chrome';

/** Set after a successful launch; surfaced in task log output. */
type BrowserLaunchKind =
  | 'executable_path'
  | 'system_chrome'
  | 'bundled_chromium'
  | 'auto_fallback_bundled';

const BROWSER_LAUNCH_LABELS: Record<BrowserLaunchKind, string> = {
  executable_path: 'Custom Chrome/Chromium (GOLDPAN_BROWSER_EXECUTABLE_PATH)',
  system_chrome: 'System-installed Google Chrome (Playwright channel=chrome)',
  bundled_chromium: 'Playwright-bundled Chromium',
  auto_fallback_bundled: 'System Chrome unavailable, fell back to Playwright-bundled Chromium',
};

let browserPromise: Promise<Browser> | null = null;
let browserLaunchKind: BrowserLaunchKind | null = null;
let collectTimeoutMs = DEFAULT_TIMEOUT_MS;
let browserStrategy: BrowserLaunchStrategy = 'auto';
let pluginLogger: PluginContext['logger'] | null = null;
// Mirrors `GoldpanConfig.ssrfValidationEnabled`, populated by `initialize`
// from `pluginConfig.ssrfValidationEnabled`. Default `true` keeps the SSRF
// pre-flight on for callers that register the plugin standalone (tests).
// Shadow follows the same module-let convention as `browserStrategy` /
// `collectTimeoutMs` above; if the plugin layer ever moves to read context
// directly at call time, sweep all three together rather than mixing styles.
let ssrfValidationEnabled = true;

const LAUNCH_COOLDOWN_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
let consecutiveLaunchFailures = 0;
let cooldownUntil = 0;
let destroyed = false;

function parseBrowserStrategy(raw: unknown): BrowserLaunchStrategy {
  if (raw === 'bundled' || raw === 'system-chrome' || raw === 'auto') return raw;
  return 'auto';
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.GOLDPAN_BROWSER_EXECUTABLE_PATH?.trim() || undefined;
  const base = { headless: true as const };

  if (executablePath) {
    pluginLogger?.debug?.('collector-browser: launch via GOLDPAN_BROWSER_EXECUTABLE_PATH');
    const browser = await chromium.launch({ ...base, executablePath });
    browserLaunchKind = 'executable_path';
    return browser;
  }

  if (browserStrategy === 'bundled') {
    pluginLogger?.debug?.(
      'collector-browser: launch bundled Chromium (install with: pnpm exec playwright install chromium)',
    );
    const browser = await chromium.launch(base);
    browserLaunchKind = 'bundled_chromium';
    return browser;
  }

  if (browserStrategy === 'system-chrome') {
    pluginLogger?.debug?.(
      'collector-browser: launch system Google Chrome (Playwright channel=chrome)',
    );
    const browser = await chromium.launch({ ...base, channel: 'chrome' });
    browserLaunchKind = 'system_chrome';
    return browser;
  }

  try {
    pluginLogger?.debug?.('collector-browser: auto — trying system Chrome (channel=chrome)');
    const browser = await chromium.launch({ ...base, channel: 'chrome' });
    browserLaunchKind = 'system_chrome';
    return browser;
  } catch (systemErr) {
    const message = errorMessage(systemErr);
    pluginLogger?.info?.('collector-browser: system Chrome unavailable, using bundled Chromium', {
      message,
    });
    emitCollectDiagnostic(
      `collector-browser: system Google Chrome launch failed (${message}), fell back to Playwright-bundled Chromium.`,
    );
    try {
      const browser = await chromium.launch(base);
      browserLaunchKind = 'auto_fallback_bundled';
      return browser;
    } catch (bundledErr) {
      throw new Error(
        `Both browser launch strategies failed. ` +
          `System Chrome: ${message}. ` +
          `Bundled Chromium: ${errorMessage(bundledErr)}`,
        { cause: systemErr },
      );
    }
  }
}

async function launchBrowserWithTracking(): Promise<Browser> {
  try {
    const browser = await launchBrowser();
    consecutiveLaunchFailures = 0;
    cooldownUntil = 0;
    return browser;
  } catch (err) {
    consecutiveLaunchFailures++;
    if (consecutiveLaunchFailures >= MAX_CONSECUTIVE_FAILURES) {
      cooldownUntil = Date.now() + LAUNCH_COOLDOWN_MS;
      pluginLogger?.warn?.(
        `collector-browser: ${consecutiveLaunchFailures} consecutive launch failures, ` +
          `entering ${LAUNCH_COOLDOWN_MS / 1000}s cooldown`,
      );
    }
    throw err;
  }
}

async function getBrowser(): Promise<Browser> {
  if (destroyed) {
    throw new CollectorError('Browser plugin has been destroyed', 'FETCH_FAILED', false);
  }

  if (cooldownUntil > 0 && Date.now() < cooldownUntil) {
    throw new CollectorError(
      'Browser launch in cooldown after repeated failures — retrying later',
      'FETCH_FAILED',
      true,
    );
  }

  if (cooldownUntil > 0) {
    consecutiveLaunchFailures = 0;
    cooldownUntil = 0;
  }

  if (browserPromise) {
    const currentPromise = browserPromise;
    try {
      const browser = await currentPromise;
      if (browser.isConnected()) return browser;
      pluginLogger?.warn?.('collector-browser: browser disconnected, relaunching');
    } catch {
      // Launch had previously failed
    }
    if (destroyed) {
      throw new CollectorError('Browser plugin has been destroyed', 'FETCH_FAILED', false);
    }
    // Only relaunch if no other caller already replaced the promise
    if (browserPromise === currentPromise) {
      browserPromise = launchBrowserWithTracking();
      return browserPromise;
    }
    // Another caller already relaunched — use their promise
    if (browserPromise) return browserPromise;
  }
  if (destroyed) {
    throw new CollectorError('Browser plugin has been destroyed', 'FETCH_FAILED', false);
  }
  browserPromise = launchBrowserWithTracking();
  return browserPromise;
}

function createTimeoutError(): CollectorError {
  return new CollectorError('Browser collection timed out', 'TIMEOUT', true);
}

function createAbortError(signal: AbortSignal): CollectorError {
  return new CollectorError(
    `Browser collection aborted: ${formatAbortSignalReason(signal)}`,
    'ABORTED',
    false,
  );
}

function attachAbortCleanup(signal: AbortSignal, context: BrowserContext, page: Page): () => void {
  const onAbort = () => {
    void Promise.allSettled([page.close(), context.close()]);
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return () => signal.removeEventListener('abort', onAbort);
}

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'collector-browser',
  group: 'collect',
  branding: {
    name: { en: 'Browser Collector', zh: '浏览器抓取' },
    tagline: {
      en: 'Headless Chromium for JS-rendered pages',
      zh: 'Playwright 抓 JS 渲染页面',
    },
  },
  schema: z.object({
    strategy: z.enum(['auto', 'bundled', 'system-chrome']).optional(),
    executablePath: z.string().optional(),
  }),
  fields: [
    {
      name: 'strategy',
      kind: 'segmented',
      envKey: 'GOLDPAN_BROWSER_STRATEGY',
      label: { en: 'Launch strategy', zh: '启动策略' },
      hint: {
        en: 'auto: try system Chrome first, fall back to bundled.',
        zh: 'auto:优先系统 Chrome,失败 fallback 到 bundled。',
      },
      options: [
        { value: 'auto', label: { en: 'Auto', zh: '自动' } },
        { value: 'bundled', label: { en: 'Bundled Chromium', zh: '内置 Chromium' } },
        { value: 'system-chrome', label: { en: 'System Chrome', zh: '系统 Chrome' } },
      ],
      default: 'auto',
      requiresRestart: true,
    },
    {
      name: 'executablePath',
      kind: 'text',
      envKey: 'GOLDPAN_BROWSER_EXECUTABLE_PATH',
      label: { en: 'Executable path', zh: '可执行文件路径' },
      placeholder: { en: '/usr/bin/chromium', zh: '/usr/bin/chromium' },
      hint: {
        en: 'Optional. Overrides strategy when set.',
        zh: '可选。设置后忽略策略选项。',
      },
      requiresRestart: true,
    },
  ],
};

export const collectorBrowserPlugin: CollectorPlugin = {
  name: 'collector-browser',
  version: '0.1.0',
  type: 'collector',
  description: 'Browser-based collector using Playwright-rendered HTML',
  descriptions: { zh: '基于 Playwright 渲染的浏览器内容采集器' },
  priority: 10,
  settingsContribution,

  async initialize(context: PluginContext): Promise<void> {
    destroyed = false;
    pluginLogger = context.logger;
    browserStrategy = parseBrowserStrategy(context.pluginConfig.browserStrategy);
    const configuredTimeout = context.pluginConfig.collectTimeoutSeconds;
    if (typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout)) {
      collectTimeoutMs = configuredTimeout * 1000;
    }
    const ssrfFlag = context.pluginConfig.ssrfValidationEnabled;
    if (typeof ssrfFlag === 'boolean') ssrfValidationEnabled = ssrfFlag;
    pluginLogger?.info?.('collector-browser: ready', {
      browserStrategy,
      executablePathConfigured: Boolean(process.env.GOLDPAN_BROWSER_EXECUTABLE_PATH?.trim()),
      ssrfValidationEnabled,
    });
  },

  async destroy(): Promise<void> {
    destroyed = true;
    consecutiveLaunchFailures = 0;
    cooldownUntil = 0;
    if (!browserPromise) return;
    const promise = browserPromise;
    browserPromise = null;
    browserLaunchKind = null;
    const DESTROY_TIMEOUT_MS = 10_000;
    try {
      const browser = await Promise.race([
        promise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), DESTROY_TIMEOUT_MS)),
      ]);
      if (browser) {
        await Promise.race([
          browser.close(),
          new Promise<void>((resolve) => setTimeout(resolve, DESTROY_TIMEOUT_MS)),
        ]);
      }
    } catch {
      // Launch had already failed or timed out — nothing to close
    }
  },

  canHandle(input: CollectorInput): boolean {
    try {
      const url = new URL(input.url);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },

  async collect(input: CollectorInput, signal: AbortSignal): Promise<CollectorOutput> {
    if (signal.aborted) {
      throw createAbortError(signal);
    }

    await validateSsrfIfEnabled(input.url, ssrfValidationEnabled);

    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let detachAbort: (() => void) | undefined;

    try {
      const browser = await getBrowser();
      context = await browser.newContext();
      page = await context.newPage();
      detachAbort = attachAbortCleanup(signal, context, page);

      let ssrfBlockedError: CollectorError | null = null;
      await page.route('**/*', async (route) => {
        if (ssrfBlockedError) {
          await route.abort('blockedbyclient');
          return;
        }
        if (route.request().isNavigationRequest()) {
          try {
            await validateSsrfIfEnabled(route.request().url(), ssrfValidationEnabled);
          } catch (err) {
            ssrfBlockedError = new CollectorError(
              `Redirect target blocked by SSRF policy: ${route.request().url()}`,
              'FETCH_FAILED',
              false,
              err,
            );
            await route.abort('blockedbyclient');
            return;
          }
        }
        await route.continue();
      });

      const deadline = Date.now() + collectTimeoutMs;
      let response: Awaited<ReturnType<Page['goto']>>;
      try {
        response = await page.goto(input.url, {
          timeout: collectTimeoutMs,
          waitUntil: 'domcontentloaded',
        });
      } catch (gotoErr) {
        if (ssrfBlockedError) throw ssrfBlockedError;
        throw gotoErr;
      }
      if (ssrfBlockedError) throw ssrfBlockedError;

      if (response && response.status() >= 400) {
        throw new CollectorError(
          `HTTP ${response.status()} from ${input.url}`,
          'FETCH_FAILED',
          response.status() >= 500,
        );
      }
      const remaining = Math.max(deadline - Date.now(), 1000);
      await page.waitForLoadState('networkidle', {
        timeout: remaining,
      });

      if (signal.aborted) {
        throw createAbortError(signal);
      }
      if (ssrfBlockedError) throw ssrfBlockedError;

      const finalUrl = page.url();
      const html = await page.content();

      pluginLogger?.info?.('browser collector rendered page', {
        url: input.url,
        finalUrl,
      });

      const parsed = parseCollectedHtml(html, finalUrl);
      const kind = browserLaunchKind ?? 'bundled_chromium';
      return {
        ...parsed,
        metadata: {
          ...parsed.metadata,
          collector_browserEngine: kind,
          collector_browserEngineLabel: BROWSER_LAUNCH_LABELS[kind],
        },
      };
    } catch (error) {
      if (error instanceof CollectorError) throw error;
      if (signal.aborted) {
        throw createAbortError(signal);
      }
      if (error instanceof playwrightErrors.TimeoutError) {
        throw createTimeoutError();
      }
      throw new CollectorError(
        `Browser collection failed: ${errorMessage(error)}`,
        'FETCH_FAILED',
        true,
        error,
      );
    } finally {
      detachAbort?.();
      await Promise.allSettled(
        [page?.close(), context?.close()].filter(Boolean) as Promise<unknown>[],
      );
    }
  },
};

export const goldpanPlugin = collectorBrowserPlugin;
