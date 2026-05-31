import * as lark from '@larksuiteoapi/node-sdk';
import type { EventDispatcherLike, WSClientLike } from '../transport/ws-client.js';

export interface WSFactoryInput {
  appId: string;
  appSecret: string;
  /** Resolved URL form (e.g. `https://open.feishu.cn` / `https://open.larksuite.com`). */
  domain: string;
}

/**
 * Construct a Lark REST Client used for non-WebSocket calls (bot identity,
 * message send). Kept alongside the WSClient factory so every SDK
 * construction point lives in `src/sdk/*` — adapter.ts never sees `new lark.*`.
 */
export function createLarkClient(input: WSFactoryInput): lark.Client {
  return new lark.Client({
    appId: input.appId,
    appSecret: input.appSecret,
    domain: input.domain,
  });
}

/**
 * The SDK marks these methods/properties as internal but does not hide
 * them at runtime. We pin the SDK version in `package.json` so a
 * breaking shape change shows up at install time, not in production.
 */
export interface SdkWSClientInternals {
  eventDispatcher: unknown;
  reConnect(isStart: boolean): Promise<void>;
  getReconnectInfo(): { lastConnectTime: number; nextConnectTime: number };
  close(params?: { force?: boolean }): void;
}

/**
 * Wrap an SDK `WSClient`-shaped object into the readiness-aware
 * `WSClientLike` the transport expects.
 *
 * The SDK's public `WSClient.start(...)` only stores the event
 * dispatcher and calls `reConnect(true)` *without* awaiting it (verified
 * against `@larksuiteoapi/node-sdk@1.61.1`, `lib/index.js:85631-85648`).
 * We replicate those two steps but `await` the connection attempt
 * directly so callers get a real "first handshake settled" barrier.
 *
 * After the await we inspect `getReconnectInfo()`: when
 * `nextConnectTime > 0` the SDK has scheduled a background retry, which
 * is the public-API way to detect that the first handshake failed; we
 * close the half-open client and throw so the runtime surfaces the
 * channel as `error` rather than letting it sit in `running` with a
 * dead connection.
 *
 * Exported (rather than inlined into `createWSClient`) so unit tests can
 * inject an in-memory `SdkWSClientInternals` fake without mocking the
 * whole `@larksuiteoapi/node-sdk` module.
 */
export function wrapSdkWSClient(inner: SdkWSClientInternals): WSClientLike {
  return {
    async start({ eventDispatcher }) {
      inner.eventDispatcher = eventDispatcher;
      await inner.reConnect(true);
      const info = inner.getReconnectInfo();
      if (info.nextConnectTime > 0) {
        // Background retry scheduled → the first handshake failed and
        // the SDK fell back into its auto-reconnect loop. Tear that
        // loop down so we don't leak a half-open client, then surface
        // the failure to the caller.
        inner.close();
        throw new Error(
          'Feishu WSClient: first WebSocket handshake failed; SDK scheduled a background retry. ' +
            'Verify network reachability, app credentials, and that "Receive events through persistent connection" is enabled in the Lark developer console.',
        );
      }
    },
    close() {
      inner.close();
    },
  };
}

/**
 * Construct a Lark WSClient. Per SDK v1.61, the WSClient constructor does NOT
 * accept `encryptKey` — encryption is strictly an `EventDispatcher` concern.
 * Passing `encryptKey` here would be silently ignored; keeping this wrapper
 * as the only construction site prevents that regression.
 *
 * `autoReconnect: true` is pinned explicitly — `wrapSdkWSClient`'s handshake
 * failure detection reads `getReconnectInfo().nextConnectTime`, which is
 * ONLY set by the SDK's auto-reconnect fallback path (see `lib/index.js`
 * line 85440-85442: when `autoReconnect` is false the SDK returns from
 * `reConnect` without touching `nextConnectTime`, so a failed first
 * handshake would silently appear successful). The SDK defaults it to
 * `true` already; fixing it here makes that dependency auditable instead
 * of implicit.
 */
export function createWSClient(input: WSFactoryInput): WSClientLike {
  const inner = new lark.WSClient({
    appId: input.appId,
    appSecret: input.appSecret,
    domain: input.domain,
    autoReconnect: true,
  });
  return wrapSdkWSClient(inner as unknown as SdkWSClientInternals);
}

/**
 * Construct a Lark EventDispatcher. `encryptKey` is optional — only provide it
 * when the admin panel has "Encrypt Key" configured. The core config layer
 * rejects explicit empty-strings so `encryptKey === undefined` here
 * reliably means "encryption off".
 */
export function createEventDispatcher(opts: { encryptKey?: string } = {}): EventDispatcherLike {
  return new lark.EventDispatcher({
    ...(opts.encryptKey ? { encryptKey: opts.encryptKey } : {}),
  }) as unknown as EventDispatcherLike;
}
