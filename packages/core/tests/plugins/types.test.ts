import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { ToolOutputValidationError } from '../../src/plugins/errors';
import type { GoldpanPlugin, PluginType, ToolPlugin } from '../../src/plugins/types';

describe('ToolPlugin type', () => {
  it('PluginType includes tool', () => {
    const t: PluginType = 'tool';
    expect(t).toBe('tool');
  });

  it('ToolPlugin satisfies GoldpanPlugin', () => {
    const plugin: ToolPlugin = {
      name: 'test-tool',
      version: '1.0.0',
      type: 'tool',
      description: 'test',
      priority: 10,
      tools: [],
      async executeTool() {
        return {};
      },
    };
    const base: GoldpanPlugin = plugin;
    expect(base.type).toBe('tool');
  });

  it('GoldpanPlugin accepts requiredCapabilities', () => {
    const plugin: GoldpanPlugin = {
      name: 'test',
      version: '1.0.0',
      type: 'intent',
      description: 'test',
      requiredCapabilities: ['db', 'config'],
    };
    expect(plugin.requiredCapabilities).toEqual(['db', 'config']);
  });
});

describe('ToolOutputValidationError', () => {
  it('captures toolName, pluginName, and zodError', () => {
    const schema = z.object({ results: z.array(z.string()) });
    const parseResult = schema.safeParse({ results: 123 });
    if (parseResult.success) throw new Error('expected failure');
    const err = new ToolOutputValidationError('search', 'my-plugin', parseResult.error);
    expect(err).toBeInstanceOf(Error);
    expect(err.toolName).toBe('search');
    expect(err.pluginName).toBe('my-plugin');
    expect(err.zodError).toBeInstanceOf(ZodError);
    expect(err.message).toContain('my-plugin');
    expect(err.message).toContain('search');
  });
});
