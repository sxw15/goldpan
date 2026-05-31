import { describe, expect, it } from 'vitest';
import {
  buildActionBlock,
  buildButton,
  buildDivider,
  buildHeader,
  buildTextBlock,
} from '../../src/render/card-primitives.js';

describe('card primitives', () => {
  it('buildHeader: title with default blue template', () => {
    expect(buildHeader('Hello')).toEqual({
      title: { tag: 'plain_text', content: 'Hello' },
      template: 'blue',
    });
  });

  it('buildHeader: red template for errors', () => {
    expect(buildHeader('Bad', 'red').template).toBe('red');
  });

  it('buildTextBlock: produces a lark_md element by default', () => {
    expect(buildTextBlock('**bold**')).toEqual({
      tag: 'div',
      text: { tag: 'lark_md', content: '**bold**' },
    });
  });

  it('buildTextBlock: plain_text mode', () => {
    expect(buildTextBlock('raw', 'plain_text').text.tag).toBe('plain_text');
  });

  it('buildDivider: returns hr element', () => {
    expect(buildDivider()).toEqual({ tag: 'hr' });
  });

  it('buildButton: serializes value as structured object (Lark parses server-side)', () => {
    const btn = buildButton('Yes', {
      action: 'clarify',
      conversationMessageId: 42,
      optionIndex: 0,
    });
    expect(btn.tag).toBe('button');
    expect(btn.text).toEqual({ tag: 'plain_text', content: 'Yes' });
    expect(btn.type).toBe('default');
    expect(btn.value).toEqual({ action: 'clarify', conversationMessageId: 42, optionIndex: 0 });
  });

  it('buildActionBlock: wraps buttons in an action element', () => {
    const block = buildActionBlock([
      buildButton('A', { action: 'clarify', conversationMessageId: 1, optionIndex: 0 }),
    ]);
    expect(block.tag).toBe('action');
    expect(block.actions).toHaveLength(1);
  });
});
