import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectorOutput } from '@goldpan/core/plugins';
import { ERROR_MESSAGES } from './error-messages.js';
import { fail } from './errors.js';
import { formatVideoMarkdown } from './markdown.js';
import { classify } from './stderr-classifier.js';
import { findSupportedSite } from './supported-sites.js';
import { parseVtt } from './vtt-parser.js';

const STDOUT_CAP_BYTES = 16 * 1024 * 1024;
const STDERR_CAP_BYTES = 1 * 1024 * 1024;
const SIGKILL_GRACE_MS = 2000;

export interface RunLogger {
  warn?: (message: string, meta?: Record<string, unknown>) => unknown;
  debug?: (message: string, meta?: Record<string, unknown>) => unknown;
}

export interface RunOptions {
  binaryPath: string;
  timeoutMs: number;
  tmpDir: string;
  signal?: AbortSignal;
  logger?: RunLogger;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface InvokeOptions {
  url: string;
  binaryPath: string;
  timeoutMs: number;
  cookiesPath?: string;
  language: string;
  signal: AbortSignal;
  logger?: RunLogger;
}

export async function runYtDlp(args: string[], opts: RunOptions): Promise<RunResult> {
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new Error(`plugin timeout ${opts.timeoutMs}ms`)),
    opts.timeoutMs,
  );

  const signals = opts.signal
    ? [opts.signal, timeoutController.signal]
    : [timeoutController.signal];
  const combined = AbortSignal.any(signals);

  try {
    return await new Promise<RunResult>((resolve, reject) => {
      const child: ChildProcess = spawn(opts.binaryPath, args, {
        signal: combined,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputCapped = false;

      const capAndReject = (msg: string): void => {
        if (outputCapped) return;
        outputCapped = true;
        if (child.exitCode === null) child.kill('SIGKILL');
        reject(fail('FETCH_FAILED', msg, false));
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (outputCapped) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > STDOUT_CAP_BYTES) {
          capAndReject(`yt-dlp stdout exceeded ${STDOUT_CAP_BYTES} bytes`);
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (outputCapped) return;
        stderrBytes += chunk.length;
        if (stderrBytes > STDERR_CAP_BYTES) {
          capAndReject(`yt-dlp stderr exceeded ${STDERR_CAP_BYTES} bytes`);
          return;
        }
        stderrChunks.push(chunk);
      });

      const classifyAbort = (): {
        code: 'TIMEOUT' | 'ABORTED';
        retryable: boolean;
        msg: string;
      } => {
        if (timeoutController.signal.aborted) {
          return {
            code: 'TIMEOUT',
            retryable: true,
            msg: `yt-dlp timed out after ${opts.timeoutMs}ms`,
          };
        }
        return { code: 'ABORTED', retryable: false, msg: 'yt-dlp aborted by caller' };
      };

      child.on('error', (err) => {
        if (outputCapped) return;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
          reject(
            fail(
              'FETCH_FAILED',
              `yt-dlp binary not executable (${code}: ${opts.binaryPath}). Run \`goldpan yt-dlp install\` to (re-)install.`,
              false,
              err,
            ),
          );
          return;
        }
        if (combined.aborted) {
          const a = classifyAbort();
          reject(fail(a.code, a.msg, a.retryable, err));
          return;
        }
        reject(err);
      });

      child.on('close', (exitCode) => {
        if (outputCapped) return;
        if (combined.aborted) {
          const a = classifyAbort();
          reject(fail(a.code, a.msg, a.retryable));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          exitCode: exitCode ?? -1,
        });
      });

      // spawn 默认 killSignal=SIGTERM 给 yt-dlp 优雅清理；2s 后还活着才 SIGKILL 兜底
      combined.addEventListener('abort', () => {
        setTimeout(() => {
          if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
        }, SIGKILL_GRACE_MS).unref();
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function withTmpDir<T>(
  fn: (tmpDir: string) => Promise<T>,
  logger?: RunLogger,
): Promise<T> {
  const dir = join(tmpdir(), `goldpan-ytdlp-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (cleanupErr) {
      logger?.warn?.(`tmpdir cleanup failed (${dir}): ${String(cleanupErr)}`);
    }
  }
}

const SUB_LANGS_MAP: Record<string, string> = {
  en: 'en,en-US,en-GB,*',
  zh: 'zh,zh-CN,zh-Hans,zh-TW,zh-Hant,en,*',
};

function resolveSubLangs(language: string): string {
  return SUB_LANGS_MAP[language] ?? `${language},en,*`;
}

interface YtDlpJson {
  id: string;
  title: string;
  uploader?: string;
  channel?: string;
  upload_date?: string;
  duration?: number;
  description?: string;
  webpage_url?: string;
  subtitles?: Record<string, Array<{ ext: string }>>;
  automatic_captions?: Record<string, Array<{ ext: string }>>;
}

interface SubSelection {
  lang: string;
  kind: 'manual' | 'auto';
}

function parseJsonSafe(text: string, logger?: RunLogger): YtDlpJson | undefined {
  // yt-dlp --print-json 单视频取第一行 JSON object
  const firstLine = text.split('\n').find((l) => l.trim().startsWith('{'));
  if (!firstLine) return undefined;
  try {
    return JSON.parse(firstLine) as YtDlpJson;
  } catch (err) {
    logger?.warn?.(
      `yt-dlp stdout JSON parse failed: ${String(err)} (preview: ${firstLine.slice(0, 200)})`,
    );
    return undefined;
  }
}

async function findVttFile(
  tmpDir: string,
  videoId: string,
  lang: string,
): Promise<string | undefined> {
  const files = await readdir(tmpDir);
  const exact = files.find((f) => f === `${videoId}.${lang}.vtt`);
  if (exact) return join(tmpDir, exact);
  const langPrefix = files.find((f) => f.startsWith(`${videoId}.${lang}`) && f.endsWith('.vtt'));
  if (langPrefix) return join(tmpDir, langPrefix);
  // last resort handles `*` wildcard fallback (any-lang subtitle)
  const anyVtt = files.find((f) => f.startsWith(`${videoId}.`) && f.endsWith('.vtt'));
  if (anyVtt) return join(tmpDir, anyVtt);
  return undefined;
}

function selectSubtitle(
  json: YtDlpJson,
  langChain: string[],
  acceptAnyLang: boolean,
): SubSelection | undefined {
  for (const lang of langChain) {
    if (json.subtitles?.[lang]) return { lang, kind: 'manual' };
  }
  for (const lang of langChain) {
    if (json.automatic_captions?.[lang]) return { lang, kind: 'auto' };
  }
  if (acceptAnyLang) {
    const anyManual = json.subtitles ? Object.keys(json.subtitles)[0] : undefined;
    if (anyManual) return { lang: anyManual, kind: 'manual' };
    const anyAuto = json.automatic_captions ? Object.keys(json.automatic_captions)[0] : undefined;
    if (anyAuto) return { lang: anyAuto, kind: 'auto' };
  }
  return undefined;
}

export async function invokeYtDlp(opts: InvokeOptions): Promise<CollectorOutput> {
  const url = new URL(opts.url);
  const siteName = findSupportedSite(url.host)?.name ?? url.host;

  return withTmpDir(async (tmpDir) => {
    const subLangs = resolveSubLangs(opts.language);
    const langTokens = subLangs.split(',');
    const acceptAnyLang = langTokens.includes('*');
    const langChain = langTokens.filter((l) => l !== '*');

    const args = [
      opts.url,
      '--print-json',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      subLangs,
      '--convert-subs',
      'vtt',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '--socket-timeout',
      '15',
      '--retries',
      '3',
      '--paths',
      tmpDir,
      // 默认模板含空格 + 方括号 + 标题，findVttFile 拼路径会失败
      '-o',
      '%(id)s.%(ext)s',
    ];
    if (opts.cookiesPath) {
      args.push('--cookies', opts.cookiesPath);
    }

    const result = await runYtDlp(args, {
      binaryPath: opts.binaryPath,
      timeoutMs: opts.timeoutMs,
      tmpDir,
      signal: opts.signal,
      logger: opts.logger,
    });

    const failure = classify(result.stderr, result.exitCode, { logger: opts.logger });
    if (failure) {
      const json = parseJsonSafe(result.stdout, opts.logger);
      const ctx = { siteName, videoId: json?.id, lang: opts.language };
      throw fail(failure.code, ERROR_MESSAGES[failure.code](ctx), failure.retryable);
    }

    const json = parseJsonSafe(result.stdout, opts.logger);
    if (!json) {
      throw fail('PARSE_FAILED', ERROR_MESSAGES.PARSE_FAILED({ siteName }), false);
    }

    const subSelection = selectSubtitle(json, langChain, acceptAnyLang);
    if (!subSelection) {
      throw fail(
        'CONTENT_EMPTY',
        ERROR_MESSAGES.CONTENT_EMPTY({ siteName, videoId: json.id, lang: opts.language }),
        false,
      );
    }

    const subtitleFilePath = await findVttFile(tmpDir, json.id, subSelection.lang);
    if (!subtitleFilePath) {
      throw fail(
        'CONTENT_EMPTY',
        `${siteName} ${subSelection.kind} subtitle ${subSelection.lang} claimed by metadata but no VTT file written by yt-dlp`,
        false,
      );
    }

    const vttContent = await readFile(subtitleFilePath, 'utf-8');
    const transcript = parseVtt(vttContent, subSelection.kind);

    const markdown = formatVideoMarkdown({
      title: json.title,
      uploader: json.uploader ?? siteName,
      channel: json.channel ?? json.uploader ?? siteName,
      uploadDate: json.upload_date ?? '',
      durationSec: json.duration ?? 0,
      webpageUrl: json.webpage_url ?? opts.url,
      description: json.description ?? '',
      transcript,
      subtitleLang: subSelection.lang,
      subtitleKind: subSelection.kind,
    });

    return {
      title: json.title,
      content: markdown,
      // CollectorOutput.finalUrl 必填，优先 yt-dlp canonical URL
      finalUrl: json.webpage_url ?? opts.url,
      metadata: {
        collector_video_id: json.id,
        collector_video_uploader: json.uploader,
        collector_video_channel: json.channel,
        collector_video_duration_sec: json.duration,
        collector_video_subtitle_lang: subSelection.lang,
        collector_video_subtitle_kind: subSelection.kind,
        collector_video_upload_date: json.upload_date
          ? `${json.upload_date.slice(0, 4)}-${json.upload_date.slice(4, 6)}-${json.upload_date.slice(6, 8)}`
          : undefined,
      },
    };
  }, opts.logger);
}
