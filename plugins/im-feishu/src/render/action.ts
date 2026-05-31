import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { RenderContext } from '@goldpan/im-runtime';
import { createTranslator, type SupportedLanguage } from '../i18n/loader.js';
import type { FeishuCardReply } from '../types.js';
import { buildCard, buildHeader, buildTextBlock } from './card-primitives.js';

export function renderAction(
  result: Extract<IntentPluginResult, { type: 'action' }>,
  ctx: RenderContext,
): FeishuCardReply {
  const t = createTranslator((ctx.language as SupportedLanguage) ?? 'en');
  return {
    kind: 'interactive',
    card: buildCard({
      header: buildHeader(t('render.action.header', {}), 'grey'),
      elements: [buildTextBlock(result.message)],
    }),
  };
}
