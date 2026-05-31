import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { RenderContext } from '@goldpan/im-runtime';
import { createTranslator, type SupportedLanguage } from '../i18n/loader.js';
import type { FeishuCardReply } from '../types.js';
import { buildCard, buildHeader, buildTextBlock } from './card-primitives.js';

export function renderSubmit(
  result: Extract<IntentPluginResult, { type: 'submit' }>,
  ctx: RenderContext,
): FeishuCardReply {
  const r = result.result;
  const t = createTranslator((ctx.language as SupportedLanguage) ?? 'en');
  if (r.status === 'accepted') {
    const text =
      r.urlCount && r.urlCount > 1
        ? t('submit.accepted_with_urls', { taskId: r.taskId, urlCount: r.urlCount })
        : t('submit.accepted', { taskId: r.taskId });
    return {
      kind: 'interactive',
      card: buildCard({
        header: buildHeader(t('render.submit.header_accepted', {}), 'green'),
        elements: [buildTextBlock(text)],
      }),
    };
  }
  if (r.status === 'duplicate') {
    return {
      kind: 'interactive',
      card: buildCard({
        header: buildHeader(t('render.submit.header_accepted', {}), 'grey'),
        elements: [buildTextBlock(t('submit.duplicate', { existingSourceId: r.existingSourceId }))],
      }),
    };
  }
  // rejected
  const localized = t(`submit_reject.${r.code}`, { reason: r.reason });
  return {
    kind: 'interactive',
    card: buildCard({
      header: buildHeader(t('render.submit.header_rejected', {}), 'grey'),
      elements: [buildTextBlock(localized)],
    }),
  };
}
