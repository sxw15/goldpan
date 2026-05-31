import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { RenderContext } from '@goldpan/im-runtime';
import { createTranslator, type SupportedLanguage } from '../i18n/loader.js';
import type { FeishuCardReply } from '../types.js';
import { buildCard, buildHeader, buildTextBlock } from './card-primitives.js';

export function renderContent(
  result: Extract<IntentPluginResult, { type: 'content' }>,
  ctx: RenderContext,
): FeishuCardReply {
  const t = createTranslator((ctx.language as SupportedLanguage) ?? 'en');
  const title = result.title ?? t('render.content.header', {});
  const mode = result.format === 'markdown' ? 'lark_md' : 'plain_text';
  return {
    kind: 'interactive',
    card: buildCard({
      header: buildHeader(title, 'blue'),
      elements: [buildTextBlock(result.text, mode)],
    }),
  };
}
