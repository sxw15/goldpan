import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVtt } from '../src/vtt-parser';

const fixturesDir = join(import.meta.dirname, 'fixtures');
const readFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

describe('parseVtt', () => {
  it('parses clean manual subtitles into joined sentences', () => {
    const result = parseVtt(readFixture('clean-manual.vtt'));
    expect(result).toContain('Hello and welcome to the show.');
    expect(result).toContain('Today we discuss software architecture.');
    expect(result).toContain("Let's start with the basics.");
  });

  it('strips inline VTT tags (<c>, <00:00:00.000>, <v>, <i>, <b>)', () => {
    const result = parseVtt(readFixture('youtube-rolling-auto.vtt'));
    expect(result).not.toMatch(/<c>|<\/c>|<\d{2}:\d{2}/);
  });

  it('dedupes rolling auto-captions (cue N starts with cue N-1)', () => {
    const result = parseVtt(readFixture('youtube-rolling-auto.vtt'));
    const helloMatches = result.match(/hello/g) ?? [];
    expect(helloMatches.length).toBe(1);
    expect(result).toContain('hello and welcome to the show');
  });

  it('skips WEBVTT header / NOTE blocks / STYLE blocks', () => {
    const input = `WEBVTT
Kind: captions

NOTE this is a note

STYLE
::cue { color: white; }

00:00:00.000 --> 00:00:02.000
real content
`;
    const result = parseVtt(input);
    expect(result.trim()).toBe('real content');
  });

  it('handles empty cue', () => {
    const input = `WEBVTT

00:00:00.000 --> 00:00:01.000

00:00:01.000 --> 00:00:02.000
content
`;
    const result = parseVtt(input);
    expect(result).toContain('content');
  });

  it('handles Chinese subtitles', () => {
    const input = `WEBVTT

00:00:00.000 --> 00:00:03.000
你好，欢迎来到我们的节目。

00:00:03.000 --> 00:00:06.000
今天我们讨论软件架构。
`;
    const result = parseVtt(input);
    expect(result).toContain('你好，欢迎来到我们的节目。');
    expect(result).toContain('今天我们讨论软件架构。');
  });

  it('preserves prefix-sharing cues in manual mode (rolling dedup is auto-only)', () => {
    // 真实 manual 字幕场景：连续两句同前缀
    const input = `WEBVTT

00:00:00.000 --> 00:00:02.000
I want

00:00:02.000 --> 00:00:04.000
I want pizza
`;
    const manual = parseVtt(input, 'manual');
    expect(manual).toBe('I want I want pizza');

    const auto = parseVtt(input, 'auto');
    // rolling dedup 把 cue N 中等于 cue N-1 的前缀剔掉，留增量；
    // 对真实 YouTube auto-caption 这是想要的，对 manual 字幕则会吃内容
    expect(auto).toBe('I want pizza');
  });
});
