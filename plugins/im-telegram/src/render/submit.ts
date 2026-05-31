import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { RenderContext } from '@goldpan/im-runtime';
import { createTranslator, type SupportedLanguage } from '../i18n/loader.js';
import type { TelegramReplyPayload } from '../types.js';

export function renderSubmit(
  result: Extract<IntentPluginResult, { type: 'submit' }>,
  ctx: RenderContext,
): TelegramReplyPayload {
  const r = result.result;
  const lang = (ctx.language as SupportedLanguage) ?? 'en';
  const t = createTranslator(lang);

  switch (r.status) {
    case 'accepted': {
      const text =
        r.urlCount && r.urlCount > 1
          ? t('submit.accepted_with_urls', { taskId: r.taskId, urlCount: r.urlCount })
          : t('submit.accepted', { taskId: r.taskId });
      return { text, format: 'plain' };
    }
    case 'duplicate': {
      const text = t('submit.duplicate', { existingSourceId: r.existingSourceId });
      return { text, format: 'plain' };
    }
    case 'rejected': {
      const localized = t(`submit_reject.${r.code}`, { reason: r.reason });
      return { text: `❌ ${localized}`, format: 'plain' };
    }
    default:
      return {
        text: `Unknown status: ${(r as { status: string }).status}`,
        format: 'plain' as const,
      };
  }
}
