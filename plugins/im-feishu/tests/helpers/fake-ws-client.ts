type EventHandler = (event: unknown) => Promise<void> | void;

export interface FakeWSClient {
  start(opts: { eventDispatcher: FakeEventDispatcher }): Promise<void>;
  /** Real SDK's close is synchronous; the fake mirrors that signature. */
  close(): void;
  startCalls: number;
  closeCalls: number;
}

export interface FakeEventDispatcher {
  register(handlers: Record<string, EventHandler>): FakeEventDispatcher;
  /** Inspectable map for tests (event type → installed handler). */
  handlers: Map<string, EventHandler>;
}

export function createFakeEventDispatcher(): FakeEventDispatcher {
  const handlers = new Map<string, EventHandler>();
  const dispatcher: FakeEventDispatcher = {
    handlers,
    register(input) {
      for (const [k, v] of Object.entries(input)) {
        handlers.set(k, v);
      }
      return dispatcher;
    },
  };
  return dispatcher;
}

export function createFakeWSClient(): FakeWSClient {
  const client: FakeWSClient = {
    startCalls: 0,
    closeCalls: 0,
    async start() {
      client.startCalls += 1;
    },
    close() {
      client.closeCalls += 1;
    },
  };
  return client;
}
