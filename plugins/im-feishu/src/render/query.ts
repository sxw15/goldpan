import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { RenderContext } from '@goldpan/im-runtime';
import { createTranslator, type SupportedLanguage } from '../i18n/loader.js';
import type { FeishuCardReply } from '../types.js';
import {
  buildCard,
  buildDivider,
  buildHeader,
  buildTextBlock,
  type LarkElement,
} from './card-primitives.js';

export function renderQuery(
  result: Extract<IntentPluginResult, { type: 'query' }>,
  ctx: RenderContext,
): FeishuCardReply {
  const t = createTranslator((ctx.language as SupportedLanguage) ?? 'en');
  const elements: LarkElement[] = [buildTextBlock(result.result.answer)];
  if (result.result.confidence !== 'high') {
    elements.push(
      buildTextBlock(`*${t('render.query.confidence_label', {})}: ${result.result.confidence}*`),
    );
  }
  const cited = result.citedEntities ?? [];
  if (cited.length > 0) {
    elements.push(buildDivider());
    elements.push(buildTextBlock(`**${t('render.query.sources_heading', {})}**`));
    for (const e of cited) {
      // Escape Lark markdown control chars so entity names containing `*`,
      // `_`, `[` etc. can't break the surrounding markup.
      const safeName = e.name.replace(/[\\*_`[\]()]/g, '\\$&');
      elements.push(buildTextBlock(`- ${safeName}`));
    }
  }
  const card = buildCard({
    header: buildHeader(t('render.query.header', {}), 'blue'),
    elements,
  });
  return { kind: 'interactive', card };
}
