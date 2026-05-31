import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { RenderContext } from '@goldpan/im-runtime';
import { createTranslator, type SupportedLanguage } from '../i18n/loader.js';
import type { FeishuCardReply } from '../types.js';
import {
  buildActionBlock,
  buildButton,
  buildCard,
  buildHeader,
  buildTextBlock,
  type LarkElement,
} from './card-primitives.js';

export function renderClarify(
  result: Extract<IntentPluginResult, { type: 'clarify' }>,
  ctx: RenderContext,
): FeishuCardReply {
  const t = createTranslator((ctx.language as SupportedLanguage) ?? 'en');
  const conversationMessageId = ctx.assistantMessageId ?? 0;
  const elements: LarkElement[] = [buildTextBlock(result.question)];
  if (result.options && result.options.length > 0) {
    const buttons = result.options.map((label: string, optionIndex: number) =>
      buildButton(label, { action: 'clarify', conversationMessageId, optionIndex }),
    );
    elements.push(buildActionBlock(buttons));
  }
  const card = buildCard({
    header: buildHeader(t('render.clarify.header', {}), 'blue'),
    elements,
  });
  return { kind: 'interactive', card };
}
