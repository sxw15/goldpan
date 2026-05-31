import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { RenderContext } from '@goldpan/im-runtime';
import { createTranslator, type SupportedLanguage } from '../i18n/loader.js';
import type { TelegramReplyPayload } from '../types.js';
import { escapeHtml, markdownToTelegramHtml } from './html.js';

export function renderQuery(
  result: Extract<IntentPluginResult, { type: 'query' }>,
  _ctx: RenderContext,
): TelegramReplyPayload {
  const t = createTranslator((_ctx.language as SupportedLanguage) ?? 'en');
  const body = markdownToTelegramHtml(result.result.answer);
  const parts = [body];

  if (result.result.confidence !== 'high') {
    const label = t('query.confidence_label', {});
    parts.push('', `<i>${label}: ${result.result.confidence}</i>`);
  }

  const cited = result.citedEntities ?? [];
  if (cited.length > 0) {
    const heading = t('query.sources_heading', {});
    const lines = cited.map((e: { id: number; name: string }) => `• ${escapeHtml(e.name)}`);
    parts.push('', `<b>${heading}</b>`, ...lines);
  }
  return { text: parts.join('\n'), format: 'html' };
}
