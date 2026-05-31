import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BinaryManager, resolveBinaryFilename } from '../src/binary-manager';

describe('resolveBinaryFilename', () => {
  it('linux x64 → yt-dlp_linux', () => {
    expect(resolveBinaryFilename({ platform: 'linux', arch: 'x64' })).toBe('yt-dlp_linux');
  });
  it('linux arm64 → yt-dlp_linux_aarch64', () => {
    expect(resolveBinaryFilename({ platform: 'linux', arch: 'arm64' })).toBe(
      'yt-dlp_linux_aarch64',
    );
  });
  it('darwin → yt-dlp_macos (universal binary)', () => {
    expect(resolveBinaryFilename({ platform: 'darwin', arch: 'x64' })).toBe('yt-dlp_macos');
    expect(resolveBinaryFilename({ platform: 'darwin', arch: 'arm64' })).toBe('yt-dlp_macos');
  });
  it('win32 x64 → yt-dlp.exe', () => {
    expect(resolveBinaryFilename({ platform: 'win32', arch: 'x64' })).toBe('yt-dlp.exe');
  });
  it('throws for unsupported platform', () => {
    expect(() =>
      resolveBinaryFilename({
        platform: 'freebsd' as NodeJS.Platform,
        arch: 'x64',
      }),
    ).toThrow(/unsupported/i);
  });
});

describe('BinaryManager', () => {
  it('uses ytDlpBinaryPath escape hatch when set', async () => {
    const mgr = new BinaryManager({
      ytDlpBinaryPath: '/usr/local/bin/yt-dlp',
      binaryDir: '/tmp/ignored',
      autoUpdate: true,
      pinnedVersion: '2026.01.15',
      updateCheckIntervalH: 24,
    });
    const path = await mgr.getBinaryPath();
    expect(path).toBe('/usr/local/bin/yt-dlp');
  });
});

describe('BinaryManager.downloadVersion', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'binmgr-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('downloads binary, verifies SHA256, writes version.txt', async () => {
    const fakeBinary = Buffer.from('fake yt-dlp binary content');
    const expectedSha = createHash('sha256').update(fakeBinary).digest('hex');
    const filename = resolveBinaryFilename();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('SHA2-256SUMS')) {
        return new Response(`${expectedSha}  ${filename}\n`);
      }
      if (u.includes(filename)) {
        return new Response(fakeBinary);
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const mgr = new BinaryManager({
      binaryDir: testDir,
      autoUpdate: true,
      pinnedVersion: '2026.01.15',
      updateCheckIntervalH: 24,
    });

    await mgr.downloadVersion('2026.01.15');

    const versionContent = await readFile(join(testDir, 'version.txt'), 'utf-8');
    expect(versionContent).toBe('2026.01.15');
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(expect.stringContaining('2026.01.15/SHA2-256SUMS'));
    // 所有 fetch 都带 user-agent + signal（timeout/abort guard）
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'user-agent': expect.stringContaining('goldpan') },
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects download on SHA256 mismatch', async () => {
    const filename = resolveBinaryFilename();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('SHA2-256SUMS')) {
        // 64 hex chars but won't match the actual content's hash
        return new Response(`${'0'.repeat(64)}  ${filename}\n`);
      }
      return new Response('actual content');
    });

    const mgr = new BinaryManager({
      binaryDir: testDir,
      autoUpdate: true,
      pinnedVersion: '2026.01.15',
      updateCheckIntervalH: 24,
    });

    await expect(mgr.downloadVersion('2026.01.15')).rejects.toThrow(/sha256|checksum|mismatch/i);
  });
});

describe('BinaryManager.ensureBinary', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'binmgr-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('downloads pinned version on first call when binary missing', async () => {
    const fakeBinary = Buffer.from('binary v1');
    const sha = createHash('sha256').update(fakeBinary).digest('hex');
    const filename = resolveBinaryFilename();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('SHA2-256SUMS')) return new Response(`${sha}  ${filename}\n`);
      if (u.includes(filename)) return new Response(fakeBinary);
      if (u.includes('/releases/latest'))
        return new Response(JSON.stringify({ tag_name: '2026.01.15' }));
      throw new Error(`unexpected fetch ${u}`);
    });
    const mgr = new BinaryManager({
      binaryDir: testDir,
      autoUpdate: true,
      pinnedVersion: '2026.01.15',
      updateCheckIntervalH: 24,
    });
    const path = await mgr.getBinaryPath();
    expect(path).toContain(testDir);
    expect(existsSync(path)).toBe(true);
  });

  it('dedupes concurrent first downloads (single download)', async () => {
    let downloadCount = 0;
    const fakeBinary = Buffer.from('binary v1');
    const sha = createHash('sha256').update(fakeBinary).digest('hex');
    const filename = resolveBinaryFilename();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('SHA2-256SUMS')) return new Response(`${sha}  ${filename}\n`);
      if (u.includes(filename)) {
        downloadCount++;
        return new Response(fakeBinary);
      }
      if (u.includes('/releases/latest'))
        return new Response(JSON.stringify({ tag_name: '2026.01.15' }));
      throw new Error(`unexpected fetch ${u}`);
    });
    const mgr = new BinaryManager({
      binaryDir: testDir,
      autoUpdate: false,
      pinnedVersion: '2026.01.15',
      updateCheckIntervalH: 24,
    });
    await Promise.all([mgr.getBinaryPath(), mgr.getBinaryPath(), mgr.getBinaryPath()]);
    expect(downloadCount).toBe(1);
  });

  it('switches binary version when pinnedVersionOverride differs from existing version.txt', async () => {
    const oldBinary = Buffer.from('old binary');
    const newBinary = Buffer.from('new binary');
    const newSha = createHash('sha256').update(newBinary).digest('hex');
    const filename = resolveBinaryFilename();
    // 先 seed 旧版本 binary + version.txt
    await writeFile(join(testDir, filename), oldBinary);
    await chmod(join(testDir, filename), 0o755);
    await writeFile(join(testDir, 'version.txt'), '2026.01.10');

    let downloadedVersion = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('SHA2-256SUMS')) {
        const m = u.match(/download\/([^/]+)\//);
        downloadedVersion = m?.[1] ?? '';
        return new Response(`${newSha}  ${filename}\n`);
      }
      if (u.includes(filename)) return new Response(newBinary);
      throw new Error(`unexpected fetch ${u}`);
    });

    const mgr = new BinaryManager({
      binaryDir: testDir,
      autoUpdate: false,
      pinnedVersion: '2026.01.10',
      pinnedVersionOverride: '2026.02.20',
      updateCheckIntervalH: 24,
    });
    await mgr.getBinaryPath();

    expect(downloadedVersion).toBe('2026.02.20');
    const versionContent = await readFile(join(testDir, 'version.txt'), 'utf-8');
    expect(versionContent).toBe('2026.02.20');
  });

  it('forceUpgrade downloads and reports upgraded=true even when binary already exists', async () => {
    const oldBinary = Buffer.from('old');
    const newBinary = Buffer.from('new content');
    const newSha = createHash('sha256').update(newBinary).digest('hex');
    const filename = resolveBinaryFilename();
    await writeFile(join(testDir, filename), oldBinary);
    await chmod(join(testDir, filename), 0o755);
    await writeFile(join(testDir, 'version.txt'), '2026.01.10');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/releases/latest'))
        return new Response(JSON.stringify({ tag_name: '2026.04.01' }));
      if (u.endsWith('SHA2-256SUMS')) return new Response(`${newSha}  ${filename}\n`);
      if (u.includes(filename)) return new Response(newBinary);
      throw new Error(`unexpected fetch ${u}`);
    });

    const mgr = new BinaryManager({
      binaryDir: testDir,
      autoUpdate: true,
      pinnedVersion: '2026.01.10',
      updateCheckIntervalH: 24,
    });
    const result = await mgr.forceUpgrade();
    expect(result).toEqual({ version: '2026.04.01', upgraded: true });
    const v = await readFile(join(testDir, 'version.txt'), 'utf-8');
    expect(v).toBe('2026.04.01');
  });

  it('forceUpgrade reports upgraded=false when already at target version', async () => {
    const fakeBinary = Buffer.from('current');
    const filename = resolveBinaryFilename();
    await writeFile(join(testDir, filename), fakeBinary);
    await chmod(join(testDir, filename), 0o755);
    await writeFile(join(testDir, 'version.txt'), '2026.04.01');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/releases/latest'))
        return new Response(JSON.stringify({ tag_name: '2026.04.01' }));
      throw new Error(`should not fetch binary when already at target: ${u}`);
    });

    const mgr = new BinaryManager({
      binaryDir: testDir,
      autoUpdate: true,
      pinnedVersion: '2026.01.10',
      updateCheckIntervalH: 24,
    });
    const result = await mgr.forceUpgrade();
    expect(result).toEqual({ version: '2026.04.01', upgraded: false });
  });

  it('downloadVersion tolerates SHA2-256SUMS lines with leading * or ./', async () => {
    const fakeBinary = Buffer.from('content');
    const sha = createHash('sha256').update(fakeBinary).digest('hex');
    const filename = resolveBinaryFilename();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      // 模拟 BSD-style sha256sum -b 输出（带 `*` 前缀表示 binary mode）
      if (u.endsWith('SHA2-256SUMS')) return new Response(`${sha} *${filename}\n`);
      if (u.includes(filename)) return new Response(fakeBinary);
      throw new Error(`unexpected fetch ${u}`);
    });

    const mgr = new BinaryManager({
      binaryDir: testDir,
      autoUpdate: false,
      pinnedVersion: '2026.01.15',
      updateCheckIntervalH: 24,
    });
    await expect(mgr.downloadVersion('2026.01.15')).resolves.toBeUndefined();
  });

  it('uses cached latestTag for 24h, does not re-query GitHub', async () => {
    const fakeBinary = Buffer.from('binary v1');
    const sha = createHash('sha256').update(fakeBinary).digest('hex');
    const filename = resolveBinaryFilename();
    await writeFile(join(testDir, filename), fakeBinary);
    await chmod(join(testDir, filename), 0o755);
    await writeFile(join(testDir, 'version.txt'), '2026.01.15');

    let latestQueryCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/releases/latest')) {
        latestQueryCount++;
        return new Response(JSON.stringify({ tag_name: '2026.01.15' }));
      }
      if (u.endsWith('SHA2-256SUMS')) return new Response(`${sha}  ${filename}\n`);
      if (u.includes(filename)) return new Response(fakeBinary);
      throw new Error(`unexpected fetch ${u}`);
    });

    const mgr = new BinaryManager({
      binaryDir: testDir,
      autoUpdate: true,
      pinnedVersion: '2026.01.15',
      updateCheckIntervalH: 24,
    });

    await mgr.getBinaryPath();
    await mgr.getBinaryPath();
    // 两次调用合并到同一个 latest 查询缓存，GitHub API 只查一次
    expect(latestQueryCount).toBe(1);
  });
});
