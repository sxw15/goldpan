import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanLlmProviderPlugins } from '../../src/plugins/scan';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'goldpan-scan-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePlugin(folder: string, body: string): void {
  const root = path.join(dir, folder);
  const dist = path.join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: folder, type: 'module' }));
  writeFileSync(path.join(dist, 'index.js'), body);
}

describe('scanLlmProviderPlugins', () => {
  it('returns empty when plugins dir missing', async () => {
    expect(await scanLlmProviderPlugins(path.join(dir, 'nonexistent'))).toEqual([]);
  });

  it('skips folders without dist/index.js', async () => {
    mkdirSync(path.join(dir, 'partial'), { recursive: true });
    expect(await scanLlmProviderPlugins(dir)).toEqual([]);
  });

  it('returns name + providerId for valid llm-provider plugins', async () => {
    writePlugin(
      'llm-cohere',
      `export const goldpanPlugin = {
         type: 'llm-provider',
         name: 'llm-cohere',
         version: '0.1.0',
         description: 'Cohere',
         providerId: 'cohere',
         createProvider: () => ({ languageModel: () => ({}) }),
       };`,
    );
    const result = await scanLlmProviderPlugins(dir);
    expect(result).toEqual([{ name: 'llm-cohere', providerId: 'cohere' }]);
  });

  it('skips non-llm-provider plugin types', async () => {
    writePlugin(
      'collector-x',
      `export const goldpanPlugin = {
         type: 'collector',
         name: 'collector-x',
         version: '0.1.0',
         description: 'X',
         priority: 1,
         canHandle: () => true,
         collect: async () => ({}),
       };`,
    );
    expect(await scanLlmProviderPlugins(dir)).toEqual([]);
  });

  it('skips broken modules without throwing', async () => {
    writePlugin('broken', 'this is not valid javascript at all');
    expect(await scanLlmProviderPlugins(dir)).toEqual([]);
  });

  it('skips im-* and web-* folders (consistent with loadExternalPlugins)', async () => {
    writePlugin(
      'im-telegram',
      `export const goldpanPlugin = {
         type: 'llm-provider', name: 'im-telegram', version: '0.1.0',
         description: '', providerId: 'irrelevant',
         createProvider: () => ({ languageModel: () => ({}) }),
       };`,
    );
    expect(await scanLlmProviderPlugins(dir)).toEqual([]);
  });
});
