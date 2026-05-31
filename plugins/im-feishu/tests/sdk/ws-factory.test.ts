import { describe, expect, it, vi } from 'vitest';
import { type SdkWSClientInternals, wrapSdkWSClient } from '../../src/sdk/ws-factory.js';

interface FakeOptions {
  /**
   * If supplied, `reConnect(true)` returns a manually-controlled Promise
   * that resolves only when `releaseReConnect()` is called. We use this
   * (rather than a setTimeout-based delay) so the readiness assertion
   * is grounded in observable causality — `start()` cannot resolve
   * until the test releases reConnect — instead of clock arithmetic
   * that flakes on slow CI machines.
   */
  manualReConnect?: boolean;
  /** What `getReconnectInfo()` returns AFTER `reConnect(true)` settles. */
  postReconnect?: { lastConnectTime: number; nextConnectTime: number };
}

interface FakeSdk extends SdkWSClientInternals {
  reConnectCalls: Array<boolean>;
  closeCalls: number;
  releaseReConnect?: () => void;
}

function createFakeSdk(opts: FakeOptions = {}): FakeSdk {
  let release: (() => void) | undefined;
  const fake: FakeSdk = {
    eventDispatcher: null,
    reConnectCalls: [],
    closeCalls: 0,
    async reConnect(isStart: boolean) {
      this.reConnectCalls.push(isStart);
      if (opts.manualReConnect) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
    getReconnectInfo() {
      return opts.postReconnect ?? { lastConnectTime: Date.now(), nextConnectTime: 0 };
    },
    close(_params?: { force?: boolean }) {
      this.closeCalls += 1;
    },
  };
  if (opts.manualReConnect) {
    fake.releaseReConnect = () => {
      // `release` is assigned synchronously inside the Promise executor
      // the first time `reConnect` is awaited; tests that toggle this
      // flag must call `start()` before invoking `releaseReConnect`.
      if (!release) throw new Error('releaseReConnect called before reConnect was awaited');
      release();
    };
  }
  return fake;
}

describe('wrapSdkWSClient', () => {
  it('start() awaits reConnect(true) before resolving (real readiness barrier)', async () => {
    const fake = createFakeSdk({ manualReConnect: true });
    const client = wrapSdkWSClient(fake);
    const dispatcher = { register: vi.fn() };

    let resolved = false;
    const startPromise = client.start({ eventDispatcher: dispatcher as never }).then(() => {
      resolved = true;
    });

    // Flush microtasks so reConnect is definitely awaited and the
    // executor has run (assigning `release`). If `start()` were not
    // awaiting reConnect, `resolved` would already be true here.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(fake.reConnectCalls).toEqual([true]);

    fake.releaseReConnect?.();
    await startPromise;
    expect(resolved).toBe(true);
    expect(fake.eventDispatcher).toBe(dispatcher);
  });

  it('start() throws + closes the SDK client when nextConnectTime > 0 (handshake failed → background retry)', async () => {
    const fake = createFakeSdk({
      postReconnect: { lastConnectTime: Date.now(), nextConnectTime: Date.now() + 5000 },
    });
    const client = wrapSdkWSClient(fake);

    await expect(client.start({ eventDispatcher: {} as never })).rejects.toThrow(
      /first WebSocket handshake failed/,
    );
    expect(fake.closeCalls).toBe(1);
  });

  it('start() does NOT close the SDK client when nextConnectTime === 0 (handshake succeeded)', async () => {
    const fake = createFakeSdk({
      postReconnect: { lastConnectTime: Date.now(), nextConnectTime: 0 },
    });
    const client = wrapSdkWSClient(fake);

    await client.start({ eventDispatcher: {} as never });
    expect(fake.closeCalls).toBe(0);
  });

  it('close() forwards to the underlying SDK client.close()', () => {
    const fake = createFakeSdk();
    const client = wrapSdkWSClient(fake);

    client.close();
    expect(fake.closeCalls).toBe(1);
  });
});
