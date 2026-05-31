import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index';

describe('GOLDPAN_TIMEZONE config', () => {
  let original: NodeJS.ProcessEnv;

  beforeEach(() => {
    original = { ...process.env };
    delete process.env.GOLDPAN_TIMEZONE;
    delete process.env.TZ;
  });

  afterEach(() => {
    process.env = original;
  });

  it('accepts a valid IANA tz', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GOLDPAN_TIMEZONE = 'Asia/Shanghai';
    const cfg = loadConfig();
    expect(cfg.timezone).toBe('Asia/Shanghai');
  });

  it('accepts Etc/GMT-8 fixed-offset form', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GOLDPAN_TIMEZONE = 'Etc/GMT-8';
    const cfg = loadConfig();
    expect(cfg.timezone).toBe('Etc/GMT-8');
  });

  it('rejects ambiguous abbreviation', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GOLDPAN_TIMEZONE = 'CST';
    expect(() => loadConfig()).toThrow(/timezone/i);
  });

  it('falls back to host tz when GOLDPAN_TIMEZONE absent', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.TZ = 'Asia/Tokyo';
    const cfg = loadConfig();
    expect(cfg.timezone).toBe('Asia/Tokyo');
  });
});
