import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';

describe('/api/healthz', () => {
  // Snapshot/restore of GOLDPAN_LANGUAGE so flipping it inside a test
  // doesn't leak across the file.
  const original = process.env.GOLDPAN_LANGUAGE;

  beforeEach(() => {
    delete process.env.GOLDPAN_LANGUAGE;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.GOLDPAN_LANGUAGE;
    } else {
      process.env.GOLDPAN_LANGUAGE = original;
    }
  });

  it('returns ok:true and a 16-hex dualProcessConfigHash', async () => {
    process.env.GOLDPAN_LANGUAGE = 'en';
    const response = GET();
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(typeof body.dualProcessConfigHash).toBe('string');
    expect(body.dualProcessConfigHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hash changes when GOLDPAN_LANGUAGE changes (cross-process drift can be detected)', async () => {
    process.env.GOLDPAN_LANGUAGE = 'en';
    const en = (await GET().json()).dualProcessConfigHash;

    process.env.GOLDPAN_LANGUAGE = 'zh';
    const zh = (await GET().json()).dualProcessConfigHash;

    expect(en).not.toBe(zh);
  });
});
