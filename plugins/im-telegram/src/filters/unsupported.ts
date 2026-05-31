import type { FilterDecision, InboundFilter, InboundMessage } from '@goldpan/im-runtime';

export interface TelegramUnsupportedOptions {
  /**
   * Localized reply text for unsupported content. Resolved by the adapter from the
   * channel-local i18n table (`filter.unsupported_content`) so this filter stays
   * translator-agnostic and consistent with the rest of the channel's surfaces.
   */
  message: string;
}

export class TelegramUnsupportedFilter implements InboundFilter {
  readonly name = 'telegram-unsupported';
  constructor(private opts: TelegramUnsupportedOptions) {}

  shouldHandle(msg: InboundMessage): FilterDecision {
    if (msg.contentType === 'text') {
      return { type: 'pass' };
    }
    return {
      type: 'short_circuit',
      reply: { text: this.opts.message, format: 'plain' },
    };
  }
}
