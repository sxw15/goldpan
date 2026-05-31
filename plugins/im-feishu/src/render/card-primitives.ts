import type { CardActionValue } from '../types.js';

export type LarkHeaderTemplate = 'blue' | 'red' | 'green' | 'grey' | 'turquoise';

export interface LarkHeader {
  title: { tag: 'plain_text'; content: string };
  template: LarkHeaderTemplate;
}

export interface LarkTextBlock {
  tag: 'div';
  text: { tag: 'lark_md' | 'plain_text'; content: string };
}

export interface LarkDivider {
  tag: 'hr';
}

export interface LarkButton {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  type: 'default' | 'primary' | 'danger';
  value: CardActionValue;
}

export interface LarkActionBlock {
  tag: 'action';
  actions: LarkButton[];
}

export type LarkElement = LarkTextBlock | LarkDivider | LarkActionBlock | LarkButton;

export function buildHeader(title: string, template: LarkHeaderTemplate = 'blue'): LarkHeader {
  return { title: { tag: 'plain_text', content: title }, template };
}

export function buildTextBlock(
  content: string,
  mode: 'lark_md' | 'plain_text' = 'lark_md',
): LarkTextBlock {
  return { tag: 'div', text: { tag: mode, content } };
}

export function buildDivider(): LarkDivider {
  return { tag: 'hr' };
}

export function buildButton(
  label: string,
  value: CardActionValue,
  type: 'default' | 'primary' | 'danger' = 'default',
): LarkButton {
  return { tag: 'button', text: { tag: 'plain_text', content: label }, type, value };
}

export function buildActionBlock(buttons: LarkButton[]): LarkActionBlock {
  return { tag: 'action', actions: buttons };
}

export interface BuildCardOptions {
  header: LarkHeader;
  elements: LarkElement[];
}

export function buildCard(opts: BuildCardOptions): Record<string, unknown> {
  return { header: opts.header, elements: opts.elements };
}
