import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanReadmeForExtraction } from '../src/readme-cleaner.js';

const fixture = (name: string) =>
  readFileSync(path.resolve(import.meta.dirname, 'fixtures', name), 'utf-8');

describe('cleanReadmeForExtraction', () => {
  it('removes shields.io and codecov badges', () => {
    const cleaned = cleanReadmeForExtraction(fixture('readme-noisy.md'));
    expect(cleaned).not.toContain('img.shields.io');
    expect(cleaned).not.toContain('codecov.io/gh/');
  });

  it('removes HTML comments', () => {
    const cleaned = cleanReadmeForExtraction(fixture('readme-noisy.md'));
    expect(cleaned).not.toContain('<!-- TOC -->');
    expect(cleaned).not.toContain('<!-- vim');
  });

  it('preserves <table>, <details>, emoji shortcodes', () => {
    const cleaned = cleanReadmeForExtraction(fixture('readme-noisy.md'));
    expect(cleaned).toContain('<table>');
    expect(cleaned).toContain('<details>');
    expect(cleaned).toContain(':rocket:');
  });

  it('leaves a clean README unchanged except for trimming', () => {
    const input = fixture('readme-clean.md');
    const cleaned = cleanReadmeForExtraction(input);
    expect(cleaned).toBe(input.trim());
  });
});
