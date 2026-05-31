import { describe, expect, it, vi } from 'vitest';
import { createFeishuTransport } from '../../src/transport/ws-client.js';
import { createFakeEventDispatcher, createFakeWSClient } from '../helpers/fake-ws-client.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

describe('createFeishuTransport', () => {
  it('registers message and card-action handlers, then starts the WSClient', async () => {
    const dispatcher = createFakeEventDispatcher();
    const wsClient = createFakeWSClient();

    const onMessage = vi.fn(async () => {});
    const onCardAction = vi.fn(async () => {});

    const transport = await createFeishuTransport({
      wsClientFactory: () => wsClient,
      eventDispatcherFactory: () => dispatcher,
      onMessageEvent: onMessage,
      onCardActionEvent: onCardAction,
      logger: stubLogger,
    });

    expect(dispatcher.handlers.has('im.message.receive_v1')).toBe(true);
    expect(dispatcher.handlers.has('card.action.trigger')).toBe(true);

    await transport.start();
    expect(wsClient.startCalls).toBe(1);

    await dispatcher.handlers.get('im.message.receive_v1')!({ test: 'msg' });
    expect(onMessage).toHaveBeenCalledWith({ test: 'msg' });

    await dispatcher.handlers.get('card.action.trigger')!({ test: 'card' });
    expect(onCardAction).toHaveBeenCalledWith({ test: 'card' });
  });

  it('shutdown calls wsClient.close()', async () => {
    const dispatcher = createFakeEventDispatcher();
    const wsClient = createFakeWSClient();
    const transport = await createFeishuTransport({
      wsClientFactory: () => wsClient,
      eventDispatcherFactory: () => dispatcher,
      onMessageEvent: async () => {},
      onCardActionEvent: async () => {},
      logger: stubLogger,
    });
    await transport.shutdown();
    expect(wsClient.closeCalls).toBe(1);
  });

  it('swallows + logs errors thrown by onMessageEvent so one bad event does not crash the transport', async () => {
    const dispatcher = createFakeEventDispatcher();
    const wsClient = createFakeWSClient();
    const logger = { ...stubLogger, error: vi.fn() } as never;
    const boom = new Error('boom');

    await createFeishuTransport({
      wsClientFactory: () => wsClient,
      eventDispatcherFactory: () => dispatcher,
      onMessageEvent: async () => {
        throw boom;
      },
      onCardActionEvent: async () => {},
      logger,
    });

    // Fire the handler directly; the wrapper should NOT reject.
    await expect(dispatcher.handlers.get('im.message.receive_v1')!({})).resolves.toBeUndefined();
    expect((logger as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled();
  });
});
