import { createTranslator } from '../i18n/loader.js';
import type { FeishuCardReply } from '../types.js';
import { buildCard, buildHeader, buildTextBlock } from './card-primitives.js';

export interface RenderResetData {
  archived: boolean;
  language: 'en' | 'zh';
}

/** Feishu `/reset` confirmation card — grey header, single status line. */
export function renderResetCard(data: RenderResetData): FeishuCardReply {
  const t = createTranslator(data.language);
  const message = data.archived ? t('render.reset.archived', {}) : t('render.reset.no_active', {});
  return {
    kind: 'interactive',
    card: buildCard({
      header: buildHeader(t('render.action.header', {}), 'grey'),
      elements: [buildTextBlock(message)],
    }),
  };
}
