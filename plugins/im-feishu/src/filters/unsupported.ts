import type { FilterDecision, InboundFilter, InboundMessage } from '@goldpan/im-runtime';
import type { Translator } from '../i18n/loader.js';
import type { FeishuTextReply } from '../types.js';

export interface FeishuUnsupportedContentOptions {
  /**
   * Translator bound to the adapter's language. The filter resolves the
   * `filter.feishu.unsupported_content` key at match time with
   * `{ type: msg.contentType }` so the user sees *which* content type was
   * rejected (e.g. "image not yet supported"). The adapter must NOT
   * pre-render a static string at construction time — that would freeze
   * `type` to whatever happened to be in the first rejected message.
   */
  translator: Translator;
}

/**
 * Rejects non-text Feishu messages with a localized short-circuit reply.
 * Used in conjunction with the group-mention filter, which runs first.
 */
export class FeishuUnsupportedContentFilter implements InboundFilter {
  readonly name = 'feishu-unsupported-content';
  constructor(private opts: FeishuUnsupportedContentOptions) {}

  shouldHandle(msg: InboundMessage): FilterDecision {
    if (msg.contentType === 'text') return { type: 'pass' };
    const reply: FeishuTextReply = {
      kind: 'text',
      text: this.opts.translator('filter.feishu.unsupported_content', { type: msg.contentType }),
    };
    return { type: 'short_circuit', reply };
  }
}
