import { initI18n, resetI18n } from '@goldpan/core/i18n';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  compilePluginPrompt,
  computePluginPromptHash,
  loadPluginPrompt,
} from '../src/prompt-loader.js';

beforeEach(() => {
  resetI18n();
  initI18n('en');
});

describe('prompt-loader', () => {
  it('loads github_action_parser system + user templates', () => {
    const system = loadPluginPrompt('github_action_parser', true);
    const user = loadPluginPrompt('github_action_parser', false);
    expect(system).toContain('GitHub');
    expect(user).toContain('{{input}}');
  });

  it('compiles a user template injecting {{input}}', () => {
    const template = 'Hello {{input}}';
    expect(compilePluginPrompt(template, { input: 'world' })).toBe('Hello world');
  });

  it('computes a deterministic short hash', () => {
    const h1 = computePluginPromptHash('a', 'b');
    const h2 = computePluginPromptHash('a', 'b');
    expect(h1).toBe(h2);
    expect(h1.length).toBe(8);
  });
});
