import type { RenderContext } from '@goldpan/im-runtime';
import { createTranslator, type SupportedLanguage } from '../i18n/loader.js';
import type { FeishuCardReply } from '../types.js';
import { buildCard, buildHeader, buildTextBlock } from './card-primitives.js';

export function renderError(
  code: string,
  vars: Record<string, unknown>,
  ctx: RenderContext,
): FeishuCardReply {
  const t = createTranslator((ctx.language as SupportedLanguage) ?? 'en');
  // plain_text mode instead of lark_md: error codes and interpolated messages
  // (especially the `unknown` template's `${message}` — raw exception text
  // from upstream) can contain backticks, `*`, `_`, `[`, `(` that would break
  // out of Lark markdown formatting. Errors are rendered literally by design.
  const card = buildCard({
    header: buildHeader(t('render.error.header', {}), 'red'),
    elements: [buildTextBlock(code, 'plain_text'), buildTextBlock(t(code, vars), 'plain_text')],
  });
  return { kind: 'interactive', card };
}
