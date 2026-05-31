import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { CollectorError } from '@goldpan/core/plugins';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeYtDlp, runYtDlp } from '../src/runner';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);

function mockSpawnReturn(stdout: string, stderr: string, exitCode: number): EventEmitter {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: (sig?: string) => void;
    exitCode: number | null;
  };
  proc.stdout = Readable.from([Buffer.from(stdout)]);
  proc.stderr = Readable.from([Buffer.from(stderr)]);
  proc.kill = vi.fn();
  proc.exitCode = null;
  setImmediate(() => proc.emit('close', exitCode));
  return proc;
}

describe('runYtDlp', () => {
  afterEach(() => mockedSpawn.mockReset());

  it('returns stdout / stderr / exitCode on normal completion', async () => {
    mockedSpawn.mockReturnValue(
      mockSpawnReturn('{"id":"abc"}', '[youtube] abc: progress', 0) as never,
    );
    const result = await runYtDlp(['https://youtube.com/watch?v=abc'], {
      binaryPath: '/tmp/yt-dlp',
      timeoutMs: 1000,
      tmpDir: '/tmp/test',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"id":"abc"');
  });

  it('throws on AbortSignal trigger', async () => {
    const controller = new AbortController();
    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (sig?: string) => void;
      exitCode: number | null;
    };
    proc.stdout = Readable.from(['']);
    proc.stderr = Readable.from(['']);
    proc.kill = vi.fn();
    proc.exitCode = 137;
    mockedSpawn.mockReturnValue(proc as never);
    setImmediate(() => {
      controller.abort();
      proc.emit('error', new Error('aborted'));
    });
    await expect(
      runYtDlp(['url'], {
        binaryPath: '/tmp/yt-dlp',
        timeoutMs: 1000,
        tmpDir: '/tmp/test',
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe('invokeYtDlp', () => {
  const fixturesDir = join(import.meta.dirname, 'fixtures');

  afterEach(() => mockedSpawn.mockReset());

  function spawnReturning(stdout: string, stderr: string, exitCode: number): EventEmitter {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (sig?: string) => void;
      exitCode: number | null;
    };
    proc.stdout = Readable.from([Buffer.from(stdout)]);
    proc.stderr = Readable.from([Buffer.from(stderr)]);
    proc.kill = vi.fn();
    proc.exitCode = null;
    setImmediate(() => proc.emit('close', exitCode));
    return proc;
  }

  it('happy path: returns CollectorOutput with finalUrl + metadata + transcript', async () => {
    // yt-dlp --print-json 真实输出是单行 JSON；fixture 经 biome format 后是多行，
    // 需 minify 回单行让 parseJsonSafe 的 firstLine 提取拿到完整 object。
    const fixtureRaw = readFileSync(join(fixturesDir, 'youtube-success.json'), 'utf-8');
    const json = JSON.stringify(JSON.parse(fixtureRaw));
    const vtt = readFileSync(join(fixturesDir, 'clean-manual.vtt'), 'utf-8');

    mockedSpawn.mockImplementation(((_bin: string, args: readonly string[]) => {
      const pathsIdx = args.indexOf('--paths');
      const tmpDir = args[pathsIdx + 1];
      // 写入字幕文件让 invokeYtDlp 后续 readFile 拿到
      writeFile(join(tmpDir, 'abc123.en.vtt'), vtt).catch(() => {});
      return spawnReturning(`${json}\n`, '', 0);
    }) as never);

    const result = await invokeYtDlp({
      url: 'https://www.youtube.com/watch?v=abc123',
      binaryPath: '/tmp/yt-dlp',
      timeoutMs: 5000,
      language: 'en',
      signal: new AbortController().signal,
    });
    expect(result.title).toBe('Demo');
    expect(result.finalUrl).toBe('https://www.youtube.com/watch?v=abc123');
    expect(result.metadata.collector_video_id).toBe('abc123');
    expect(result.metadata.collector_video_subtitle_kind).toBe('manual');
    expect(result.content).toContain('# Demo');
    expect(result.content).toContain('Hello and welcome to the show.');
  });

  it('throws CONTENT_EMPTY (terminal=true) when no subtitles available', async () => {
    const json = JSON.stringify({
      id: 'noSub',
      title: 'NoSub',
      webpage_url: 'https://...',
      subtitles: {},
      automatic_captions: {},
    });
    mockedSpawn.mockImplementation(((..._args: unknown[]) =>
      spawnReturning(`${json}\n`, '', 0)) as never);
    await expect(
      invokeYtDlp({
        url: 'https://www.youtube.com/watch?v=noSub',
        binaryPath: '/tmp/yt-dlp',
        timeoutMs: 5000,
        language: 'en',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_EMPTY', terminal: true });
  });

  it('throws NOT_FOUND (terminal=true) on private video stderr', async () => {
    mockedSpawn.mockImplementation(((..._args: unknown[]) =>
      spawnReturning('', 'ERROR: [youtube] x: Private video. Sign in...', 1)) as never);
    await expect(
      invokeYtDlp({
        url: 'https://www.youtube.com/watch?v=x',
        binaryPath: '/tmp/yt-dlp',
        timeoutMs: 5000,
        language: 'en',
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CollectorError && err.code === 'NOT_FOUND' && err.terminal === true,
    );
  });

  it('forwards --cookies <path> to spawn args when cookiesPath set', async () => {
    const json = JSON.stringify({
      id: 'cookieDemo',
      title: 'X',
      webpage_url: 'https://...',
      subtitles: { en: [{ ext: 'vtt' }] },
      automatic_captions: {},
    });
    let capturedArgs: readonly string[] = [];
    mockedSpawn.mockImplementation(((_bin: string, args: readonly string[]) => {
      capturedArgs = args;
      const pathsIdx = args.indexOf('--paths');
      const tmpDir = args[pathsIdx + 1];
      writeFile(
        join(tmpDir, 'cookieDemo.en.vtt'),
        'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n',
      ).catch(() => {});
      return spawnReturning(`${json}\n`, '', 0);
    }) as never);

    await invokeYtDlp({
      url: 'https://www.youtube.com/watch?v=cookieDemo',
      binaryPath: '/tmp/yt-dlp',
      timeoutMs: 5000,
      language: 'en',
      signal: new AbortController().signal,
      cookiesPath: '/etc/goldpan/cookies.txt',
    });

    const cookiesIdx = capturedArgs.indexOf('--cookies');
    expect(cookiesIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[cookiesIdx + 1]).toBe('/etc/goldpan/cookies.txt');
  });

  it('omits --cookies from spawn args when cookiesPath unset', async () => {
    const json = JSON.stringify({
      id: 'noCookie',
      title: 'X',
      webpage_url: 'https://...',
      subtitles: { en: [{ ext: 'vtt' }] },
      automatic_captions: {},
    });
    let capturedArgs: readonly string[] = [];
    mockedSpawn.mockImplementation(((_bin: string, args: readonly string[]) => {
      capturedArgs = args;
      const pathsIdx = args.indexOf('--paths');
      const tmpDir = args[pathsIdx + 1];
      writeFile(
        join(tmpDir, 'noCookie.en.vtt'),
        'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n',
      ).catch(() => {});
      return spawnReturning(`${json}\n`, '', 0);
    }) as never);

    await invokeYtDlp({
      url: 'https://www.youtube.com/watch?v=noCookie',
      binaryPath: '/tmp/yt-dlp',
      timeoutMs: 5000,
      language: 'en',
      signal: new AbortController().signal,
    });
    expect(capturedArgs).not.toContain('--cookies');
  });

  it('selects fallback subtitle when * wildcard is in lang chain (only non-preferred lang available)', async () => {
    // user language='en' → langChain en,en-US,en-GB,*
    // 视频只有 fr 字幕 → 旧逻辑 CONTENT_EMPTY；新逻辑选 fr fallback
    const json = JSON.stringify({
      id: 'frOnly',
      title: 'French Only',
      webpage_url: 'https://...',
      subtitles: { fr: [{ ext: 'vtt' }] },
      automatic_captions: {},
    });
    mockedSpawn.mockImplementation(((_bin: string, args: readonly string[]) => {
      const pathsIdx = args.indexOf('--paths');
      const tmpDir = args[pathsIdx + 1];
      writeFile(
        join(tmpDir, 'frOnly.fr.vtt'),
        'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nbonjour\n',
      ).catch(() => {});
      return spawnReturning(`${json}\n`, '', 0);
    }) as never);

    const result = await invokeYtDlp({
      url: 'https://www.youtube.com/watch?v=frOnly',
      binaryPath: '/tmp/yt-dlp',
      timeoutMs: 5000,
      language: 'en',
      signal: new AbortController().signal,
    });
    expect(result.metadata.collector_video_subtitle_lang).toBe('fr');
    expect(result.metadata.collector_video_subtitle_kind).toBe('manual');
  });

  it('throws PARSE_FAILED (terminal=true, non-retryable) when stdout is non-JSON despite exit 0', async () => {
    mockedSpawn.mockImplementation(((..._args: unknown[]) =>
      spawnReturning('not a json line at all', '', 0)) as never);
    await expect(
      invokeYtDlp({
        url: 'https://www.youtube.com/watch?v=x',
        binaryPath: '/tmp/yt-dlp',
        timeoutMs: 5000,
        language: 'en',
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CollectorError &&
        err.code === 'PARSE_FAILED' &&
        err.terminal === true &&
        err.retryable === false,
    );
  });

  it('maps spawn ENOENT to FETCH_FAILED non-retryable with actionable hint', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (sig?: string) => void;
      exitCode: number | null;
    };
    proc.stdout = Readable.from(['']);
    proc.stderr = Readable.from(['']);
    proc.kill = vi.fn();
    proc.exitCode = null;
    mockedSpawn.mockReturnValue(proc as never);
    setImmediate(() => {
      const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      proc.emit('error', err);
    });

    await expect(
      runYtDlp(['url'], {
        binaryPath: '/nonexistent/yt-dlp',
        timeoutMs: 5000,
        tmpDir: '/tmp/test',
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CollectorError &&
        err.code === 'FETCH_FAILED' &&
        err.terminal === true &&
        err.retryable === false &&
        err.message.includes('goldpan yt-dlp install'),
    );
  });
});
