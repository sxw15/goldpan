import { describe, expect, it } from 'vitest';
import { rewriteMarkdownLinks } from '../src/markdown-rewrite.js';

describe('rewriteMarkdownLinks', () => {
  const ctx = { owner: 'facebook', repo: 'react', defaultBranch: 'main' };

  it('rewrites relative markdown link to blob URL', () => {
    const out = rewriteMarkdownLinks('See [docs](./docs/foo.md).', ctx);
    expect(out).toBe('See [docs](https://github.com/facebook/react/blob/main/docs/foo.md).');
  });

  it('rewrites relative image to raw URL', () => {
    const out = rewriteMarkdownLinks('![alt](./assets/x.png)', ctx);
    expect(out).toBe('![alt](https://raw.githubusercontent.com/facebook/react/main/assets/x.png)');
  });

  it('leaves absolute links untouched', () => {
    const out = rewriteMarkdownLinks('[home](https://example.com)', ctx);
    expect(out).toBe('[home](https://example.com)');
  });

  it('leaves anchor links untouched', () => {
    const out = rewriteMarkdownLinks('[jump](#install)', ctx);
    expect(out).toBe('[jump](#install)');
  });
});
