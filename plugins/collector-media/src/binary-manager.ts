import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RELEASE_URL_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/download';
const GITHUB_LATEST_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const USER_AGENT = 'goldpan-collector-media';
const FETCH_TIMEOUT_SHORT_MS = 10_000;
const FETCH_TIMEOUT_BINARY_MS = 60_000;
const RETRY_BACKOFF_MS = 1500;

export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}

export interface BinaryManagerLogger {
  warn?: (message: string, meta?: Record<string, unknown>) => unknown;
  info?: (message: string, meta?: Record<string, unknown>) => unknown;
  debug?: (message: string, meta?: Record<string, unknown>) => unknown;
}

export interface BinaryManagerOptions {
  ytDlpBinaryPath?: string;
  binaryDir: string;
  autoUpdate: boolean;
  pinnedVersion: string;
  pinnedVersionOverride?: string;
  updateCheckIntervalH: number;
  logger?: BinaryManagerLogger;
}

export function resolveBinaryFilename(info: PlatformInfo = process): string {
  const { platform, arch } = info;
  if (platform === 'linux' && arch === 'x64') return 'yt-dlp_linux';
  if (platform === 'linux' && arch === 'arm64') return 'yt-dlp_linux_aarch64';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'win32' && arch === 'x64') return 'yt-dlp.exe';
  throw new Error(
    `unsupported platform/arch combo: ${platform}/${arch}. Set GOLDPAN_YT_DLP_BINARY_PATH to use an external binary.`,
  );
}

interface FetchGuardOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  logger?: BinaryManagerLogger;
  description: string;
}

async function fetchWithGuard(url: string, opts: FetchGuardOptions): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(
      () => timeoutCtrl.abort(new Error(`fetch timeout ${opts.timeoutMs}ms`)),
      opts.timeoutMs,
    );
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;
    try {
      const res = await fetch(url, {
        signal,
        headers: { 'user-agent': USER_AGENT },
      });
      if (res.ok) return res;
      const transient = res.status === 429 || res.status >= 500;
      if (attempt === 0 && transient) {
        opts.logger?.warn?.(
          `${opts.description}: HTTP ${res.status}, retrying once after ${RETRY_BACKOFF_MS}ms`,
        );
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      if (attempt === 0) {
        opts.logger?.warn?.(`${opts.description}: ${String(err)}, retrying once`);
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${opts.description}: retry exhausted`);
}

export class BinaryManager {
  private downloadPromise: Promise<string> | null = null;
  private upgradePromise: Promise<void> | null = null;
  private latestTagCache: { checkedAt: number; tag: string } | null = null;
  private latestTagPromise: Promise<string> | null = null;

  constructor(private readonly options: BinaryManagerOptions) {}

  async getBinaryPath(signal?: AbortSignal): Promise<string> {
    if (this.options.ytDlpBinaryPath) return this.options.ytDlpBinaryPath;
    return this.ensureBinary(signal);
  }

  private get binaryFilePath(): string {
    return join(this.options.binaryDir, resolveBinaryFilename());
  }

  private get versionFilePath(): string {
    return join(this.options.binaryDir, 'version.txt');
  }

  async readVersion(): Promise<string | undefined> {
    try {
      const content = await readFile(this.versionFilePath, 'utf-8');
      return content.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async writeVersion(version: string): Promise<void> {
    await writeFile(this.versionFilePath, version, 'utf-8');
  }

  binaryExists(): boolean {
    return existsSync(this.binaryFilePath);
  }

  async downloadVersion(version: string, signal?: AbortSignal): Promise<void> {
    await mkdir(this.options.binaryDir, { recursive: true });

    const filename = resolveBinaryFilename();
    const sumsUrl = `${RELEASE_URL_BASE}/${version}/SHA2-256SUMS`;
    const binaryUrl = `${RELEASE_URL_BASE}/${version}/${filename}`;

    const sumsRes = await fetchWithGuard(sumsUrl, {
      timeoutMs: FETCH_TIMEOUT_SHORT_MS,
      signal,
      logger: this.options.logger,
      description: `fetch SHA2-256SUMS ${version}`,
    });
    if (!sumsRes.ok) {
      throw new Error(`Failed to fetch SHA2-256SUMS for ${version}: HTTP ${sumsRes.status}`);
    }
    const sumsText = await sumsRes.text();
    const expectedSha = parseExpectedSha(sumsText, filename);
    if (!expectedSha) {
      throw new Error(`No SHA256 entry for ${filename} in SHA2-256SUMS`);
    }

    const binaryRes = await fetchWithGuard(binaryUrl, {
      timeoutMs: FETCH_TIMEOUT_BINARY_MS,
      signal,
      logger: this.options.logger,
      description: `fetch ${filename} ${version}`,
    });
    if (!binaryRes.ok) {
      throw new Error(`Failed to fetch ${filename} for ${version}: HTTP ${binaryRes.status}`);
    }
    const buf = Buffer.from(await binaryRes.arrayBuffer());
    const tmpPath = `${this.binaryFilePath}.tmp-${Date.now()}-${process.pid}`;
    await writeFile(tmpPath, buf);

    const actualSha = createHash('sha256').update(buf).digest('hex');
    if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
      await unlink(tmpPath).catch(() => {});
      throw new Error(
        `SHA256 mismatch for ${filename} ${version}: expected ${expectedSha}, got ${actualSha}`,
      );
    }

    if (process.platform !== 'win32') {
      await chmod(tmpPath, 0o755);
    }

    try {
      await rename(tmpPath, this.binaryFilePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
    await this.writeVersion(version);
  }

  private ensureBinary(signal?: AbortSignal): Promise<string> {
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = this.doEnsureBinary(signal);
    return this.downloadPromise.finally(() => {
      this.downloadPromise = null;
    });
  }

  private async doEnsureBinary(signal?: AbortSignal): Promise<string> {
    const userOverride = this.options.pinnedVersionOverride;

    if (!this.binaryExists()) {
      const targetVersion = userOverride ?? (await this.resolveTargetVersion(signal));
      await this.downloadVersion(targetVersion, signal);
      return this.binaryFilePath;
    }

    if (userOverride) {
      const currentVersion = await this.readVersion();
      if (currentVersion !== userOverride) {
        this.options.logger?.info?.(
          `binary version ${currentVersion ?? '(unknown)'} != override ${userOverride}, switching`,
        );
        await this.downloadVersion(userOverride, signal);
      }
      return this.binaryFilePath;
    }

    if (!this.options.autoUpdate) return this.binaryFilePath;

    void this.scheduleBackgroundUpgrade();
    return this.binaryFilePath;
  }

  private scheduleBackgroundUpgrade(): Promise<void> {
    if (this.upgradePromise) return this.upgradePromise;
    this.upgradePromise = this.maybeBackgroundUpgrade()
      .catch((err) => {
        this.options.logger?.warn?.(`background upgrade failed: ${String(err)}`);
      })
      .finally(() => {
        this.upgradePromise = null;
      });
    return this.upgradePromise;
  }

  /**
   * Public synchronous-style upgrade for CLI: awaits the actual download, not
   * fire-and-forget. Bypasses `binaryExists()` short-circuit.
   */
  async forceUpgrade(signal?: AbortSignal): Promise<{ version: string; upgraded: boolean }> {
    const beforeVersion = await this.readVersion();
    const targetVersion =
      this.options.pinnedVersionOverride ?? (await this.resolveTargetVersion(signal));
    if (beforeVersion === targetVersion && this.binaryExists()) {
      return { version: targetVersion, upgraded: false };
    }
    await this.downloadVersion(targetVersion, signal);
    return { version: targetVersion, upgraded: beforeVersion !== targetVersion };
  }

  private async maybeBackgroundUpgrade(): Promise<void> {
    const latestTag = await this.getLatestTag();
    const currentVersion = await this.readVersion();
    if (currentVersion === latestTag) return;
    await this.downloadVersion(latestTag);
  }

  private async resolveTargetVersion(signal?: AbortSignal): Promise<string> {
    if (!this.options.autoUpdate) return this.options.pinnedVersion;
    try {
      return await this.getLatestTag(signal);
    } catch (err) {
      this.options.logger?.warn?.(
        `GitHub releases/latest unavailable, using pinned ${this.options.pinnedVersion}: ${String(err)}`,
      );
      return this.options.pinnedVersion;
    }
  }

  private async getLatestTag(signal?: AbortSignal): Promise<string> {
    const now = Date.now();
    const ttlMs = this.options.updateCheckIntervalH * 3600_000;
    if (this.latestTagCache && now - this.latestTagCache.checkedAt < ttlMs) {
      return this.latestTagCache.tag;
    }
    if (this.latestTagPromise) return this.latestTagPromise;
    this.latestTagPromise = this.fetchLatestTag(signal);
    try {
      return await this.latestTagPromise;
    } finally {
      this.latestTagPromise = null;
    }
  }

  private async fetchLatestTag(signal?: AbortSignal): Promise<string> {
    const res = await fetchWithGuard(GITHUB_LATEST_API, {
      timeoutMs: FETCH_TIMEOUT_SHORT_MS,
      signal,
      logger: this.options.logger,
      description: 'fetch GitHub releases/latest',
    });
    if (!res.ok) {
      throw new Error(`GitHub releases/latest fetch failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { tag_name?: string };
    const tag = data.tag_name;
    if (!tag) throw new Error('GitHub response missing tag_name');
    this.latestTagCache = { checkedAt: Date.now(), tag };
    return tag;
  }

  async prefetch(signal?: AbortSignal): Promise<void> {
    if (this.options.ytDlpBinaryPath) return;
    await this.ensureBinary(signal);
  }
}

function parseExpectedSha(sumsText: string, filename: string): string | undefined {
  for (const line of sumsText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([0-9a-f]{64})\s+(.+)$/i);
    if (!match) continue;
    const fileColumn = match[2].replace(/^[*./]+/, '');
    if (fileColumn === filename) return match[1];
  }
  return undefined;
}
