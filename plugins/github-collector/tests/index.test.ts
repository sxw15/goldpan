import { describe, expect, it } from 'vitest';
import { goldpanPlugin, parseEnv } from '../src/index.js';

describe('goldpanPlugin (github-collector)', () => {
  it('is a CollectorPlugin with canHandle + priority 20', () => {
    expect(goldpanPlugin.type).toBe('collector');
    expect(goldpanPlugin.name).toBe('collector-github');
    expect(goldpanPlugin.priority).toBe(20);
    expect(typeof goldpanPlugin.canHandle).toBe('function');
    expect(typeof goldpanPlugin.collect).toBe('function');
  });

  it('declares "config" capability so bootstrap injects core config (for maxContentLength fallback)', () => {
    expect(goldpanPlugin.requiredCapabilities).toContain('config');
  });
});

describe('parseEnv', () => {
  it('leaves maxContentLength undefined when GOLDPAN_GITHUB_MAX_CONTENT_LENGTH is unset (caller must fall back to core config)', () => {
    const parsed = parseEnv({});
    expect(parsed.maxContentLength).toBeUndefined();
  });

  it('parses maxContentLength when GOLDPAN_GITHUB_MAX_CONTENT_LENGTH is set', () => {
    const parsed = parseEnv({ GOLDPAN_GITHUB_MAX_CONTENT_LENGTH: '50000' });
    expect(parsed.maxContentLength).toBe(50_000);
  });
});
