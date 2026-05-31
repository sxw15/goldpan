import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CollectorError,
  type CollectorInput,
  type CollectorOutput,
  type CollectorPlugin,
  emitCollectDiagnostic,
  type PluginContext,
  type PluginSettingsContribution,
} from '@goldpan/core/plugins';
import { z } from 'zod';
import {
  BinaryManager,
  type BinaryManagerLogger,
  resolveBinaryFilename,
} from './binary-manager.js';
import { wrapAsTerminal } from './errors.js';
import { invokeYtDlp } from './runner.js';
import { isSupportedUrl } from './supported-sites.js';
import { YT_DLP_PINNED_VERSION } from './yt-dlp-version.js';

let binaryManager: BinaryManager | null = null;
let collectTimeoutMs = 90_000;
let cookiesPath: string | undefined;
let language = 'en';
let pluginLogger: PluginContext['logger'] | null = null;

interface MediaPluginConfig {
  dataDir?: string;
  ytDlpDir?: string;
  ytDlpBinaryPath?: string;
  ytDlpAutoUpdate?: boolean;
  ytDlpVersion?: string;
  ytDlpUpdateCheckIntervalH?: number;
  ytDlpCookiesPath?: string;
  mediaCollectTimeoutSeconds?: number;
  language?: string;
}

function adaptLogger(logger: PluginContext['logger']): BinaryManagerLogger {
  return {
    warn: (msg, meta) => logger.warn?.(msg, meta),
    info: (msg, meta) => logger.info?.(msg, meta),
    debug: (msg, meta) => logger.debug?.(msg, meta),
  };
}

const settingsContribution: PluginSettingsContribution = {
  pluginId: 'collector-media',
  group: 'collect',
  branding: {
    name: { en: 'Media Collector', zh: '视频抓取' },
    tagline: {
      en: 'yt-dlp-based YouTube / Bilibili / Vimeo',
      zh: '基于 yt-dlp 的 YouTube / Bilibili / Vimeo',
    },
  },
  schema: z.object({
    timeoutSec: z.number().int().positive().optional(),
    autoUpdate: z.boolean().optional(),
    binaryPath: z.string().optional(),
    cookiesPath: z.string().optional(),
  }),
  fields: [
    {
      name: 'timeoutSec',
      kind: 'number',
      envKey: 'GOLDPAN_MEDIA_COLLECT_TIMEOUT',
      label: { en: 'Timeout (seconds)', zh: '超时(秒)' },
      hint: {
        en: 'Per-request yt-dlp deadline. Default 90.',
        zh: '单次 yt-dlp 抓取超时。默认 90 秒。',
      },
      min: 10,
      max: 600,
      step: 10,
      requiresRestart: true,
    },
    {
      name: 'autoUpdate',
      kind: 'toggle',
      envKey: 'GOLDPAN_YT_DLP_AUTO_UPDATE',
      label: { en: 'Auto-update yt-dlp', zh: '自动更新 yt-dlp' },
      hint: {
        en: 'Check GitHub for new yt-dlp every 24h.',
        zh: '每 24 小时查 GitHub 是否有新 yt-dlp 版本。',
      },
      default: true,
      requiresRestart: true,
    },
    {
      name: 'binaryPath',
      kind: 'text',
      envKey: 'GOLDPAN_YT_DLP_BINARY_PATH',
      label: { en: 'yt-dlp binary path', zh: 'yt-dlp 可执行路径' },
      placeholder: { en: '/usr/local/bin/yt-dlp', zh: '/usr/local/bin/yt-dlp' },
      hint: {
        en: 'Optional. Overrides the auto-downloaded binary.',
        zh: '可选。覆盖自动下载的 binary。',
      },
      requiresRestart: true,
    },
    {
      name: 'cookiesPath',
      kind: 'text',
      envKey: 'GOLDPAN_YT_DLP_COOKIES_PATH',
      label: { en: 'Cookies file path', zh: 'Cookies 文件路径' },
      placeholder: { en: '/path/to/cookies.txt', zh: '/path/to/cookies.txt' },
      hint: {
        en: 'For login-gated videos. Netscape cookie format.',
        zh: '抓取需登录的视频时使用。Netscape cookies 格式。',
      },
      requiresRestart: true,
    },
  ],
};

export const collectorMediaPlugin: CollectorPlugin = {
  name: 'collector-media',
  version: '0.1.0',
  type: 'collector',
  description: 'yt-dlp based video collector for YouTube / Bilibili / Vimeo',
  descriptions: { zh: '基于 yt-dlp 的视频采集器，支持 YouTube / Bilibili / Vimeo' },
  priority: 20,
  settingsContribution,

  async initialize(context: PluginContext): Promise<void> {
    pluginLogger = context.logger;
    const config = context.pluginConfig as MediaPluginConfig;

    if (typeof config.mediaCollectTimeoutSeconds === 'number') {
      collectTimeoutMs = config.mediaCollectTimeoutSeconds * 1000;
    }
    if (typeof config.language === 'string') {
      language = config.language;
    }

    if (config.ytDlpCookiesPath) {
      try {
        await access(config.ytDlpCookiesPath, fsConstants.R_OK);
        cookiesPath = config.ytDlpCookiesPath;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        pluginLogger?.warn?.(
          `collector-media: cookies path ${config.ytDlpCookiesPath} not readable (${code ?? 'error'}: ${String(err)}), falling back to no-cookie mode`,
        );
        cookiesPath = undefined;
      }
    }

    const binaryDir =
      config.ytDlpDir ?? (config.dataDir ? join(config.dataDir, 'yt-dlp') : './data/yt-dlp');

    binaryManager = new BinaryManager({
      ytDlpBinaryPath: config.ytDlpBinaryPath,
      binaryDir,
      autoUpdate: config.ytDlpAutoUpdate ?? true,
      pinnedVersion: YT_DLP_PINNED_VERSION,
      pinnedVersionOverride: config.ytDlpVersion,
      updateCheckIntervalH: config.ytDlpUpdateCheckIntervalH ?? 24,
      logger: adaptLogger(pluginLogger),
    });

    // fire-and-forget prefetch（不 block initialize）
    void binaryManager.prefetch().catch((err: unknown) => {
      pluginLogger?.warn?.(
        `collector-media: binary prefetch failed (will retry on first collect): ${String(err)}`,
      );
    });

    pluginLogger?.info?.('collector-media: ready', {
      binaryDir,
      autoUpdate: config.ytDlpAutoUpdate ?? true,
      cookiesConfigured: Boolean(cookiesPath),
      timeoutMs: collectTimeoutMs,
    });
  },

  async destroy(): Promise<void> {
    binaryManager = null;
    cookiesPath = undefined;
    collectTimeoutMs = 90_000;
    language = 'en';
    pluginLogger = null;
  },

  canHandle(input: CollectorInput): boolean {
    return isSupportedUrl(input.url);
  },

  getCollectTimeoutMs(): number {
    return collectTimeoutMs;
  },

  async collect(input: CollectorInput, signal: AbortSignal): Promise<CollectorOutput> {
    if (!binaryManager) {
      throw wrapAsTerminal(new Error('plugin not initialized'));
    }
    const runLogger = pluginLogger
      ? {
          warn: (msg: string, meta?: Record<string, unknown>) => pluginLogger?.warn?.(msg, meta),
          debug: (msg: string, meta?: Record<string, unknown>) => pluginLogger?.debug?.(msg, meta),
        }
      : undefined;
    try {
      const binaryPath = await binaryManager.getBinaryPath(signal);
      return await invokeYtDlp({
        url: input.url,
        binaryPath,
        timeoutMs: collectTimeoutMs,
        cookiesPath,
        language,
        signal,
        logger: runLogger,
      });
    } catch (error) {
      if (error instanceof CollectorError) {
        const ce: CollectorError = error;
        if (ce.terminal) throw ce;
      }
      const wrapped = wrapAsTerminal(error);
      emitCollectDiagnostic(`collector-media failed: ${wrapped.message}`);
      throw wrapped;
    }
  },
};

/** Programmatic API for one-shot install/upgrade/status (no plugin lifecycle). */
export const binaryManagerApi = {
  async install(opts: { binaryDir: string; version?: string }): Promise<void> {
    const mgr = new BinaryManager({
      binaryDir: opts.binaryDir,
      autoUpdate: false,
      pinnedVersion: opts.version ?? YT_DLP_PINNED_VERSION,
      updateCheckIntervalH: 24,
    });
    await mgr.getBinaryPath();
  },
  async upgrade(opts: { binaryDir: string }): Promise<{ version: string; upgraded: boolean }> {
    const mgr = new BinaryManager({
      binaryDir: opts.binaryDir,
      autoUpdate: true,
      pinnedVersion: YT_DLP_PINNED_VERSION,
      updateCheckIntervalH: 24,
    });
    return mgr.forceUpgrade();
  },
  async status(opts: {
    binaryDir: string;
  }): Promise<{ version?: string; binaryPath: string; exists: boolean }> {
    const mgr = new BinaryManager({
      binaryDir: opts.binaryDir,
      autoUpdate: false,
      pinnedVersion: YT_DLP_PINNED_VERSION,
      updateCheckIntervalH: 24,
    });
    const binaryPath = join(opts.binaryDir, resolveBinaryFilename());
    return {
      version: await mgr.readVersion(),
      binaryPath,
      exists: mgr.binaryExists(),
    };
  },
};

export const goldpanPlugin = collectorMediaPlugin;
