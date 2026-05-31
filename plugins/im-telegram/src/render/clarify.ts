import {
  type Language as CoreLanguage,
  createTranslator as createCoreTranslator,
} from '@goldpan/core/i18n';
import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { RenderContext } from '@goldpan/im-runtime';
import type { TelegramReplyPayload } from '../types.js';
import { escapeHtml } from './html.js';

export interface ClarifyContext {
  /** ID of the assistant `conversation_messages` row holding this clarify question. */
  conversationMessageId: number;
}

/**
 * Telegram's `callback_data` is capped at 64 bytes per the Bot API. Keyed
 * chips include `intentKey` and an optional `payload`; pre-flight check the
 * encoded string before publishing the button so we never ship a keyboard
 * Telegram will reject at delivery. Plain `length` is byte-accurate for the
 * ASCII identifiers `ClarifyOptionKey` produces; for `payload` (potentially
 * UTF-8 JSON) it is a lower bound, so we use `Buffer.byteLength` to be safe.
 */
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export function renderClarify(
  result: Extract<IntentPluginResult, { type: 'clarify' }>,
  ctx: RenderContext,
  cc: ClarifyContext,
): TelegramReplyPayload {
  const text = `<b>${escapeHtml(result.question ?? '')}</b>`;

  // P4 keyed path: when the classifier produced `structuredOptions`, render
  // chips whose `callback_data` carries the resolved `intentKey` (+ optional
  // payload). The callback handler then forces that intent and skips the
  // classifier, matching the web `ClarifyResultCard` chip semantics.
  if (result.structuredOptions && result.structuredOptions.length > 0) {
    const coreT = createCoreTranslator((ctx.language as CoreLanguage) ?? 'en').t;
    const buttons: Array<{ label: string; callbackData: string }> = [];
    for (const opt of result.structuredOptions) {
      // Tracking subject picker is rendered web-side (P5 will add IM support);
      // skipping the chip here lets the rest of a mixed clarify still render
      // instead of falling all the way back to legacy index-based buttons.
      if (opt.intentKey === 'resolve_tracking_entity') continue;
      const callbackData = opt.payload
        ? `clarify:${cc.conversationMessageId}:${opt.intentKey}:${opt.payload}`
        : `clarify:${cc.conversationMessageId}:${opt.intentKey}`;
      if (Buffer.byteLength(callbackData, 'utf8') > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
        continue;
      }
      buttons.push({
        label: coreT(`intent_classifier.clarify_option.${opt.intentKey}`),
        callbackData,
      });
    }
    if (buttons.length > 0) {
      return { text, format: 'html', inlineButtons: [buttons] };
    }
    // Every chip skipped — fall through to legacy text/buttons so the user at
    // least sees the clarify question and any free-text `options` the plugin
    // still produces.
  }

  // Legacy fallback: P3 free-form `options[]` array — labels stored verbatim
  // and the index travels in `callback_data`. Keyboards already delivered
  // before P4 keep working via this branch (parseClarifyCallback's legacy shape).
  if (!result.options || result.options.length === 0) {
    return { text, format: 'html' };
  }
  const legacyButtons = result.options.map((label: string, i: number) => ({
    label,
    callbackData: `clarify:${cc.conversationMessageId}:${i}`,
  }));
  return { text, format: 'html', inlineButtons: [legacyButtons] };
}
