import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadChannels } from '@goldpan/im-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function silentLogger() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any;
}

function writePlugin(root: string, name: string, indexJs: string) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'dist', 'index.js'), indexJs);
}

const VALID_PLUGIN_BODY = `
const module = {
  manifest: {
    channelId: 'demo',
    branding: { name: { en: 'D', zh: 'D' } },
    enable: { envKey: 'GOLDPAN_IM_DEMO_ENABLED', label: { en: 'On', zh: '开' }, default: true },
    fields: [],
    actions: [],
    setupGuide: { allDoneTitle: { en: 'Done', zh: '完' }, steps: [] }
  },
  handlers: {}
};
export const goldpanIMSettings = module;
export const goldpanIMEnvSpec = { channelId: 'demo', envSchema: {}, parse: () => ({}) };
export const goldpanIMRegistration = () => null;
`;

describe('loadChannels', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'goldpan-load-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loads a valid plugin', async () => {
    writePlugin(tmp, 'im-demo', VALID_PLUGIN_BODY);
    const bundles = await loadChannels({ pluginsDir: tmp, logger: silentLogger() });
    expect(bundles).toHaveLength(1);
    expect(bundles[0].channelId).toBe('demo');
    expect(bundles[0].staticDir).toBe(path.join(tmp, 'im-demo', 'static'));
  });

  it('skips a plugin with envSpec.channelId mismatch', async () => {
    const body = VALID_PLUGIN_BODY.replace(
      "channelId: 'demo', envSchema",
      "channelId: 'wrong', envSchema",
    );
    const logger = silentLogger();
    writePlugin(tmp, 'im-demo', body);
    const bundles = await loadChannels({ pluginsDir: tmp, logger });
    expect(bundles).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('envSpec.channelId mismatch'),
    );
  });

  it('skips a plugin with malformed manifest (missing zh)', async () => {
    const body = VALID_PLUGIN_BODY.replace("name: { en: 'D', zh: 'D' }", "name: { en: 'D' }");
    const logger = silentLogger();
    writePlugin(tmp, 'im-demo', body);
    const bundles = await loadChannels({ pluginsDir: tmp, logger });
    expect(bundles).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('manifest invalid'),
      expect.any(Array),
    );
  });

  it('skips a duplicate channelId', async () => {
    writePlugin(tmp, 'im-demo-a', VALID_PLUGIN_BODY);
    writePlugin(tmp, 'im-demo-b', VALID_PLUGIN_BODY);
    const logger = silentLogger();
    const bundles = await loadChannels({ pluginsDir: tmp, logger });
    expect(bundles).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('duplicate channelId'));
  });
});
