import type { RenderContext } from '@goldpan/im-runtime';
import { createTranslator, type SupportedLanguage } from '../i18n/loader.js';
import type { TelegramReplyPayload } from '../types.js';

export function renderError(
  code: string,
  vars: Record<string, unknown>,
  ctx: RenderContext,
): TelegramReplyPayload {
  const t = createTranslator((ctx.language as SupportedLanguage) ?? 'en');
  return { text: `❌ ${t(code, vars)}`, format: 'plain' };
}
