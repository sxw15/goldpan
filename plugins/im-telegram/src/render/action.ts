import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { RenderContext } from '@goldpan/im-runtime';
import type { TelegramReplyPayload } from '../types.js';

export function renderAction(
  result: Extract<IntentPluginResult, { type: 'action' }>,
  _ctx: RenderContext,
): TelegramReplyPayload {
  return { text: result.message, format: 'plain' };
}
