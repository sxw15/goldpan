import { createTranslator } from '../i18n/loader.js';
import type { FeishuCardReply } from '../types.js';
import {
  buildCard,
  buildDivider,
  buildHeader,
  buildTextBlock,
  type LarkElement,
} from './card-primitives.js';

export interface RenderHelpData {
  commands: ReadonlyArray<{ name: string; description: string }>;
  intents: ReadonlyArray<{ name: string; description: string }>;
  language: 'en' | 'zh';
}

/**
 * Feishu `/help` card. Each command gets its own bold line; intents render
 * below a divider when any are present. Kept intentionally flat (no
 * per-command divider rows) to stay under the 25KB card size budget for
 * even very long command lists.
 */
export function renderHelpCard(data: RenderHelpData): FeishuCardReply {
  const t = createTranslator(data.language);
  const elements: LarkElement[] = [];
  for (const c of data.commands) {
    elements.push(buildTextBlock(`**/${c.name}** — ${c.description}`));
  }
  if (data.intents.length > 0) {
    elements.push(buildDivider());
    elements.push(buildTextBlock(`**${t('render.help.intents_heading', {})}**`));
    for (const i of data.intents) {
      elements.push(buildTextBlock(`${i.name} — ${i.description}`));
    }
  }
  return {
    kind: 'interactive',
    card: buildCard({
      header: buildHeader(t('render.help.header', {}), 'blue'),
      elements,
    }),
  };
}
