import type { ILogObj, Logger } from 'tslog';

/**
 * Adapters for the `@larksuiteoapi/node-sdk` WSClient + EventDispatcher.
 * Real production callers pass factory closures that wrap
 * `new lark.WSClient(...)` / `new lark.EventDispatcher(...)`; tests
 * inject in-memory fakes.
 *
 * `close()` is declared as `void` to match the real SDK's synchronous
 * shutdown semantics (verified in SDK v1.61). The transport wrapper's
 * own `shutdown` below still returns a Promise for ergonomic composition
 * with async teardown chains.
 *
 * `start()` MUST NOT resolve until the first WebSocket handshake has
 * settled (success or failure). The Lark SDK's public `WSClient.start()`
 * is fire-and-forget — it stores the dispatcher and kicks off
 * `reConnect(true)` without awaiting handshake / auth success — so the
 * SDK adapter (`sdk/ws-factory.ts`) deliberately bypasses it. If `start()`
 * was allowed to resolve early, `adapter.start()` would mark the Feishu
 * channel `running` while the persistent connection is still down, and
 * failures would only surface in background logs.
 *
 * Implementations MUST throw if the first handshake fails so the runtime
 * surfaces the channel as `error` instead of `running`.
 */
export interface WSClientLike {
  start(opts: { eventDispatcher: EventDispatcherLike }): Promise<void>;
  close(): void;
}

export interface EventDispatcherLike {
  register(handlers: Record<string, (event: unknown) => Promise<void> | void>): EventDispatcherLike;
}

export interface FeishuTransportOptions {
  wsClientFactory: () => WSClientLike;
  eventDispatcherFactory: () => EventDispatcherLike;
  onMessageEvent: (event: unknown) => Promise<void>;
  onCardActionEvent: (event: unknown) => Promise<void>;
  logger: Logger<ILogObj>;
}

export interface FeishuTransport {
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
}

/**
 * Wraps Lark's WSClient + EventDispatcher into a goldpan-shaped transport.
 * The transport's only responsibility is connect / subscribe / close —
 * message parsing (T4) and card-action handling (T7) live elsewhere and are
 * injected as closures.
 */
export async function createFeishuTransport(
  opts: FeishuTransportOptions,
): Promise<FeishuTransport> {
  const dispatcher = opts.eventDispatcherFactory();
  dispatcher.register({
    'im.message.receive_v1': async (event) => {
      try {
        await opts.onMessageEvent(event);
      } catch (err) {
        opts.logger.error('feishu message-event handler threw', err);
      }
    },
    'card.action.trigger': async (event) => {
      try {
        await opts.onCardActionEvent(event);
      } catch (err) {
        opts.logger.error('feishu card-action handler threw', err);
      }
    },
  });
  const wsClient = opts.wsClientFactory();
  return {
    async start() {
      await wsClient.start({ eventDispatcher: dispatcher });
    },
    async shutdown() {
      wsClient.close();
    },
  };
}
