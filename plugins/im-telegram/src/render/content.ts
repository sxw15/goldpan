import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { RenderContext } from '@goldpan/im-runtime';
import type { TelegramReplyPayload } from '../types.js';
import { escapeHtml, markdownToTelegramHtml } from './html.js';

export function renderContent(
  result: Extract<IntentPluginResult, { type: 'content' }>,
  _ctx: RenderContext,
): TelegramReplyPayload {
  const body =
    result.format === 'markdown' ? markdownToTelegramHtml(result.text) : escapeHtml(result.text);
  const text = result.title ? `<b>${escapeHtml(result.title)}</b>\n\n${body}` : body;
  return { text, format: 'html' };
}
