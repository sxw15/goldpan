import type { ChannelAdapter, ChannelDescriptor, InboundMessage } from '../types.js';

/**
 * Concrete payload shape emitted by the mock channel. Declared here (rather
 * than inferred from the dispatcher boundary) so tests can assert on `.text`,
 * `.format`, or `.inlineButtons` without `as { text: string }` casts.
 */
export interface MockReplyPayload {
  text: string;
  format?: 'plain' | 'markdown';
  inlineButtons?: Array<Array<{ label: string; callbackData: string }>>;
}

export interface MockChannel {
  adapter: ChannelAdapter;
  /** Sends a fake inbound message into the dispatcher (set after IMRuntime.start()). */
  emit(msg: Partial<InboundMessage> & { text: string }): Promise<void>;
  /** All payloads the channel "sent" out, in delivery order. */
  sent: MockReplyPayload[];
  /** Set by the runtime in `adapter.start(deps)`. */
  setDispatch(dispatch: (msg: InboundMessage) => Promise<void>): void;
}

export function createMockChannel(opts: { channelId?: string } = {}): MockChannel {
  const channelId = opts.channelId ?? 'mock';
  const sent: MockReplyPayload[] = [];
  let dispatch: ((msg: InboundMessage) => Promise<void>) | null = null;
  let descriptor: ChannelDescriptor = { channelId, state: 'stopped', inFlightCount: 0 };

  const adapter: ChannelAdapter = {
    channelId,
    capabilities: {
      inlineButtons: true,
      typingIndicator: false,
      richFormat: true,
      maxMessageLength: 4096,
      images: false,
      lifecycleHooks: false,
    },
    defaultFilters: [],
    renderResult: (r): MockReplyPayload => {
      switch (r.type) {
        case 'content':
          return { text: r.text, format: r.format === 'markdown' ? 'markdown' : 'plain' };
        case 'query':
          return { text: r.result.answer, format: 'plain' };
        case 'submit':
          return { text: `submit:${r.result.status}`, format: 'plain' };
        case 'action':
          return { text: r.message, format: 'plain' };
        case 'clarify':
          return {
            text: r.question ?? r.questionKey ?? '',
            format: 'plain',
            ...(r.options !== undefined
              ? {
                  inlineButtons: [
                    r.options.map((o, i) => ({ label: o, callbackData: `clarify:${i}` })),
                  ],
                }
              : {}),
          };
        case 'wait':
          return { text: `wait:${r.bufferedMessageId}`, format: 'plain' };
        case 'note':
          return { text: `note:${r.detail.id}`, format: 'plain' };
        case 'tracking_pending':
          return { text: `tracking_pending:${r.trackingRuleId}`, format: 'plain' };
      }
    },
    renderError: (code): MockReplyPayload => ({ text: `error:${code}`, format: 'plain' }),
    buildSystemReply: (text): MockReplyPayload => ({ text }),
    buildHelpReply: (data): MockReplyPayload => {
      const lines = ['Available commands:'];
      for (const c of data.commands) {
        lines.push(`  /${c.name} — ${c.description}`);
      }
      if (data.intents.length > 0) {
        lines.push('', 'Available intents:');
        for (const decl of data.intents) {
          lines.push(`  ${decl.name} — ${decl.description}`);
        }
      }
      return { text: lines.join('\n') };
    },
    buildResetReply: (data): MockReplyPayload => ({
      text: data.archived
        ? 'Done. The next message starts a fresh conversation.'
        : 'No active conversation. The next message will start a fresh one.',
    }),
    start: async (deps) => {
      dispatch = deps.dispatch;
      deps.installSendReply(async (_ref, payload) => {
        sent.push(payload as MockReplyPayload);
      });
      descriptor = { channelId, state: 'running', inFlightCount: 0 };
    },
    shutdown: async () => {
      dispatch = null;
      descriptor = { channelId, state: 'stopped', inFlightCount: 0 };
    },
    describe: () => descriptor,
  };

  return {
    adapter,
    sent,
    setDispatch: (d) => {
      dispatch = d;
    },
    emit: async (m) => {
      if (!dispatch)
        throw new Error('MockChannel.emit: dispatch not installed (call IMRuntime.start first)');
      await dispatch({
        channelId,
        accountId: 'mock-acct',
        chatId: m.chatId ?? 'chat',
        userId: m.userId ?? 'user',
        platformMsgId: m.platformMsgId ?? `m-${Math.random().toString(36).slice(2)}`,
        text: m.text,
        contentType: m.contentType ?? 'text',
        raw: m.raw ?? null,
        receivedAt: m.receivedAt ?? new Date(),
      });
    },
  };
}
