// monorepo/packages/im-runtime/src/runtime.ts

import type { HandleInputResult } from '@goldpan/core';
import { handleInput as coreHandleInput, errorMessage } from '@goldpan/core';
import {
  type ConversationContext,
  finalizeBuffer,
  reconcileExpiredBufferedBySession,
} from '@goldpan/core/conversation';
import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { ILogObj, Logger } from 'tslog';
import { ChannelRegistry } from './channel/registry.js';
import { ConversationStore } from './conversation/store.js';
import { CommandParser, defaultCommands } from './inbound/command-parser.js';
import { MessageDedupe } from './inbound/dedupe.js';
import { deliverResult, InboundDispatcher } from './inbound/dispatcher.js';
import { SessionRouter } from './inbound/router.js';
import { buildSessionKeyFromRef, type RoutingMode } from './inbound/session-key.js';
import type {
  ChannelAdapter,
  ChannelDescriptor,
  ChannelReplyPayload,
  CommandOverride,
  IMRuntimeDeps,
  InboundMessage,
  RenderContext,
  SessionRef,
} from './types.js';

/**
 * `core.handleInput` returns `Promise<HandleInputResult>`, which is the union
 * `IntentPluginResult | { type: 'error'; code: InputErrorCode; message: string }`.
 * The dispatcher narrows on `result.type === 'error'` and routes via `channel.renderError`.
 * Adapters never see exceptions for these paths — the only thing that throws here is a
 * truly unexpected internal failure (e.g. DB connection lost), which the dispatcher's
 * outer try-catch maps to the synthetic `'unknown'` error code.
 */
export type HandleInputFn = (args: {
  input: string;
  conversation: ConversationContext;
  sessionKey: string;
  sessionRef: SessionRef;
  signal: AbortSignal;
  forcedIntent?: string;
  /** P4: 与 forcedIntent 成对透传的 opaque payload，最终落到 IntentExecutionContext.payload。 */
  payload?: string;
  /**
   * P2: id of the user-turn row the dispatcher just wrote via
   * `ConversationStore.appendUserTurn`. Forwarded into `HandleInputDeps.currentUserMessageId`
   * so intent-note can pin `note.sourceMessageId` and the wait branch has a CAS target.
   */
  currentUserMessageId?: number;
}) => Promise<HandleInputResult>;

export interface IMRuntimeOptions {
  /** Default conversation window size (number of messages loaded into context). */
  conversationWindowSize?: number;
  /** Default routing mode (per_chat | per_user). Channels can override per-channel via `register`. */
  routingMode?: RoutingMode;
  /**
   * Override the input-handler. Defaults to `core.handleInput`. Tests inject mocks via this hook;
   * production code should never set this.
   */
  handleInput?: HandleInputFn;
  /**
   * Retention (hours) for `im_messages_seen` rows. Rows older than this are deleted on each
   * purge tick. The table only exists to make inbound deduplication idempotent across crashes
   * and polling-cursor rewinds — its useful window is minutes, not days. Default: 72 hours.
   * Set to 0 to disable the periodic purge entirely (rows then accumulate indefinitely).
   */
  dedupeTtlHours?: number;
  /**
   * Interval (minutes) at which the runtime sweeps `im_messages_seen` for rows past
   * {@link IMRuntimeOptions.dedupeTtlHours}. Default: 60. Set to 0 to disable.
   * The first sweep runs ~one interval after `start()` (no immediate sweep on boot).
   */
  dedupePurgeIntervalMinutes?: number;
  // NOTE: There is intentionally NO `conversationTtlHours` / similar option here.
  // `ConversationRepository.purgeArchived(olderThan)` exists, but the runtime
  // does NOT yet schedule it — the env var `GOLDPAN_IM_CONVERSATION_TTL_DAYS`
  // is parsed and surfaced on `handle.config.im.conversationTtlDays` purely for
  // future ops tooling (see `.env.example`). If you need automatic pruning,
  // wire a separate scheduler outside the runtime; do NOT re-add it here as a
  // hidden option without also wiring the timer (the asymmetry is the bug we
  // want to avoid).
}

export interface ChannelRegistration {
  /** Per-channel config slice (parsed from env by the bootstrap caller). */
  channelConfig?: Record<string, unknown>;
  /** Per-channel resolved secrets (e.g. bot tokens). */
  secrets?: Record<string, string>;
  /** Per-channel routing mode override (defaults to runtime-level setting). */
  routingMode?: RoutingMode;
}

type SendReplyFn = (ref: SessionRef, payload: ChannelReplyPayload) => Promise<void>;

/**
 * Typed error thrown by `IMRuntime.sendOutbound` when the target channel is
 * either unregistered or not in the `running` state. Consumers can branch on
 * `instanceof ChannelOperationError && err.code === 'CHANNEL_NOT_RUNNING'`
 * without raw-string sniffing or unsafe `as Error & { code }` casts.
 */
export class ChannelOperationError extends Error {
  readonly code: 'CHANNEL_NOT_FOUND' | 'CHANNEL_NOT_RUNNING';
  readonly channelId: string;
  readonly channelState?: ChannelDescriptor['state'];

  constructor(
    code: 'CHANNEL_NOT_FOUND' | 'CHANNEL_NOT_RUNNING',
    channelId: string,
    channelState?: ChannelDescriptor['state'],
  ) {
    super(
      channelState !== undefined
        ? `${code}: ${channelId} (state=${channelState})`
        : `${code}: ${channelId}`,
    );
    this.name = 'ChannelOperationError';
    this.code = code;
    this.channelId = channelId;
    if (channelState !== undefined) this.channelState = channelState;
  }
}

/**
 * State for a registered channel. Exposes the outbound plumbing (send function,
 * render-context factory, routing mode, channel-scoped logger) so that
 * `IMRuntime.sendOutbound` can reuse the same delivery path as the dispatcher
 * without duplicating closures.
 */
interface ChannelEntry {
  adapter: ChannelAdapter;
  dispatcher: InboundDispatcher;
  abortController: AbortController;
  channelConfig: Record<string, unknown>;
  secrets: Record<string, string>;
  state: ChannelDescriptor['state'];
  lastErrorAt?: Date;
  lastErrorMessage?: string;
  routingMode: RoutingMode;
  channelLogger: Logger<ILogObj>;
  sendReply: SendReplyFn;
  renderContextBuilder: (ref: SessionRef) => RenderContext;
}

export class IMRuntime {
  private registry = new ChannelRegistry();
  private entries = new Map<string, ChannelEntry>();
  private registrations = new Map<string, ChannelRegistration>();
  private logger: Logger<ILogObj>;
  private windowSize: number;
  private routingMode: RoutingMode;
  private handleInput: HandleInputFn;
  private dedupeTtlHours: number;
  private dedupePurgeIntervalMs: number;
  private dedupePurgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private deps: IMRuntimeDeps,
    options: IMRuntimeOptions = {},
  ) {
    this.logger = deps.logger.getSubLogger?.({ name: 'im-runtime' }) ?? deps.logger;
    this.windowSize = options.conversationWindowSize ?? 8;
    this.routingMode = options.routingMode ?? 'per_chat';
    this.dedupeTtlHours = options.dedupeTtlHours ?? 72;
    this.dedupePurgeIntervalMs = (options.dedupePurgeIntervalMinutes ?? 60) * 60_000;
    this.handleInput =
      options.handleInput ??
      (({ input, conversation, sessionRef, signal, forcedIntent, payload, currentUserMessageId }) =>
        coreHandleInput(input, {
          db: this.deps.db,
          callLlm: this.deps.callLlm,
          pluginRegistry: this.deps.pluginRegistry,
          config: this.deps.config,
          repos: this.deps.repos,
          logger: this.deps.logger,
          embeddingProvider: this.deps.embeddingProvider ?? undefined,
          conversation,
          sessionRef,
          signal,
          forcedIntent,
          payload,
          currentUserMessageId,
        }));
  }

  /**
   * Register a channel adapter together with its config and secrets. Both blobs are passed
   * verbatim into `ChannelStartDeps` when `start()` is invoked. Channels can also override
   * the runtime's default routing mode here.
   */
  register(adapter: ChannelAdapter, registration: ChannelRegistration = {}): void {
    this.registry.register(adapter);
    this.registrations.set(adapter.channelId, registration);
  }

  /**
   * Render and send an `IntentPluginResult` through an already-running channel
   * without an inbound message driving it. Used by plugins (e.g. scheduled
   * digests, webhook triggers) that need to push outbound messages. Throws
   * `ChannelOperationError` with `code === 'CHANNEL_NOT_FOUND'` when the
   * channel was never registered, or `code === 'CHANNEL_NOT_RUNNING'` when
   * it exists but is not in the `running` state (e.g. starting / shutting
   * down / failed start — see `describeChannels()` for diagnostics).
   */
  async sendOutbound(
    channelId: string,
    ref: SessionRef,
    result: IntentPluginResult,
  ): Promise<void> {
    const entry = this.entries.get(channelId);
    if (!entry) {
      throw new ChannelOperationError('CHANNEL_NOT_FOUND', channelId);
    }
    // Reject any non-running state. `startChannel`'s catch block sets
    // `state = 'error'` on failed starts and deliberately retains the
    // entry (so `describeChannels()` can surface the failure), and
    // shutdown walks entries through `shutting_down` → `stopped` without
    // deleting them. Calling the adapter's send path in any of those
    // windows would either 1) be a no-op the caller treats as success,
    // or 2) race with the adapter's shutdown teardown and crash the
    // underlying transport. The state machine here is the single source
    // of truth — don't rely on structural presence alone.
    if (entry.state !== 'running') {
      throw new ChannelOperationError('CHANNEL_NOT_RUNNING', channelId, entry.state);
    }
    const sessionKey = buildSessionKeyFromRef(ref, entry.routingMode);
    const renderCtx = entry.renderContextBuilder(ref);
    await deliverResult({
      channel: entry.adapter,
      ref,
      sessionKey,
      result,
      renderCtx,
      sendReply: entry.sendReply,
      logger: entry.channelLogger,
      origin: 'outbound',
    });
  }

  async start(): Promise<void> {
    if (this.entries.size > 0) {
      throw new Error('IMRuntime.start() called while already running');
    }
    let firstError: unknown;
    let hasRunningChannel = false;
    for (const adapter of this.registry.list()) {
      try {
        await this.startChannel(adapter);
        const entry = this.entries.get(adapter.channelId);
        if (entry?.state === 'running') hasRunningChannel = true;
      } catch (err) {
        firstError ??= err;
      }
    }
    if (hasRunningChannel) this.startDedupePurgeTimer();
    if (firstError !== undefined) throw firstError;
  }

  private startDedupePurgeTimer(): void {
    if (this.dedupePurgeTimer) return;
    if (this.dedupePurgeIntervalMs <= 0 || this.dedupeTtlHours <= 0) {
      this.logger.debug('IM dedupe purge disabled by config', {
        ttlHours: this.dedupeTtlHours,
        intervalMinutes: this.dedupePurgeIntervalMs / 60_000,
      });
      return;
    }
    const dedupe = new MessageDedupe(this.deps.db);
    const ttlMs = this.dedupeTtlHours * 3_600_000;
    this.dedupePurgeTimer = setInterval(() => {
      try {
        const cutoff = new Date(Date.now() - ttlMs);
        const removed = dedupe.purgeBefore(cutoff);
        if (removed > 0) {
          this.logger.debug('IM dedupe purge swept rows', {
            removed,
            cutoff: cutoff.toISOString(),
          });
        }
      } catch (err) {
        this.logger.warn('IM dedupe purge tick failed (will retry next interval)', {
          err: errorMessage(err),
        });
      }
    }, this.dedupePurgeIntervalMs);
    // Don't keep the event loop alive solely for the purge timer.
    if (typeof this.dedupePurgeTimer.unref === 'function') {
      this.dedupePurgeTimer.unref();
    }
  }

  private stopDedupePurgeTimer(): void {
    if (this.dedupePurgeTimer) {
      clearInterval(this.dedupePurgeTimer);
      this.dedupePurgeTimer = null;
    }
  }

  private async startChannel(adapter: ChannelAdapter): Promise<void> {
    const reg = this.registrations.get(adapter.channelId) ?? {};
    const routingMode = reg.routingMode ?? this.routingMode;
    const channelConfig = reg.channelConfig ?? {};
    const secrets = reg.secrets ?? {};

    const router = new SessionRouter({ routingMode });
    const parser = new CommandParser({});
    const dedupe = new MessageDedupe(this.deps.db);
    const store = new ConversationStore({
      repo: this.deps.conversationRepo,
      defaultWindowSize: this.windowSize,
    });
    const overrideCommands = mergeCommands(defaultCommands, adapter.commandOverrides ?? []);
    const intentDeclarations = this.deps.pluginRegistry.getIntentDeclarations();
    const abortController = new AbortController();
    const channelLogger = this.logger.getSubLogger?.({ name: adapter.channelId }) ?? this.logger;

    let installedSendReply: SendReplyFn | null = null;
    const sendReply: SendReplyFn = async (ref, payload) => {
      if (!installedSendReply) {
        throw new Error(
          `IMRuntime: channel "${adapter.channelId}" attempted to send a reply before its ` +
            `start(deps) hook called installSendReply(). The channel adapter must register ` +
            `its outbound transport synchronously inside start().`,
        );
      }
      return installedSendReply(ref, payload);
    };
    const renderContextBuilder = (ref: SessionRef): RenderContext => ({
      language: this.deps.config.language,
      sessionRef: ref,
      channelConfig,
      logger: channelLogger,
    });

    const dispatcher = new InboundDispatcher({
      channel: adapter,
      router,
      parser,
      dedupe,
      store,
      conversationRepo: this.deps.conversationRepo,
      handleInput: this.handleInput,
      sendReply,
      overrideCommands,
      intentDeclarations,
      logger: channelLogger,
      // P3 `/release` built-in needs to run the buffered finalize path. We
      // close over the full HandleInputDeps here so the dispatcher (which is
      // channel-agnostic and doesn't know about callLlm / pluginRegistry)
      // can invoke it via a single callback. Tests can omit this dep to skip
      // wiring core when they're only exercising unrelated paths.
      finalizeBufferedMessage: (messageId, signal) =>
        finalizeBuffer(messageId, {
          db: this.deps.db,
          repos: this.deps.repos,
          logger: channelLogger,
          handleInput: coreHandleInput,
          callLlm: this.deps.callLlm,
          pluginRegistry: this.deps.pluginRegistry,
          config: this.deps.config,
          embeddingProvider: this.deps.embeddingProvider ?? undefined,
          signal,
        }),
      // A5: 同 finalizeBufferedMessage 同一份 deps，dispatcher.runOne 入口前
      // 调用，保证 fallback assistant turn 入库早于新 user turn（ordering 修复）。
      reconcileBuffered: (sessionKey) =>
        reconcileExpiredBufferedBySession(sessionKey, {
          db: this.deps.db,
          repos: this.deps.repos,
          logger: channelLogger,
          handleInput: coreHandleInput,
          callLlm: this.deps.callLlm,
          pluginRegistry: this.deps.pluginRegistry,
          config: this.deps.config,
          embeddingProvider: this.deps.embeddingProvider ?? undefined,
        }),
      // The dispatcher forwards `language` into `CommandHandlerContext.language`
      // (for custom command overrides such as Telegram's channel-local `/start`)
      // and into the structured data passed to `channel.buildHelpReply` /
      // `buildResetReply`. Everything else flows through `renderContext`.
      language: this.deps.config.language,
      renderContextBuilder,
    });

    const entry: ChannelEntry = {
      adapter,
      dispatcher,
      abortController,
      channelConfig,
      secrets,
      state: 'starting',
      routingMode,
      channelLogger,
      sendReply,
      renderContextBuilder,
    };
    this.entries.set(adapter.channelId, entry);

    try {
      await adapter.start({
        dispatch: (msg: InboundMessage) => dispatcher.dispatch(msg),
        installSendReply: (fn) => {
          installedSendReply = fn;
        },
        configureCommandParser: (options) => {
          parser.setOptions(options);
        },
        logger: channelLogger,
        signal: abortController.signal,
        language: this.deps.config.language,
        channelConfig,
        secrets,
      });
      entry.state = 'running';
    } catch (err) {
      entry.state = 'error';
      entry.lastErrorAt = new Date();
      entry.lastErrorMessage = errorMessage(err);
      try {
        await adapter.shutdown();
      } catch (shutdownErr) {
        channelLogger.warn('channel cleanup after failed start threw; ignoring', {
          err: errorMessage(shutdownErr),
        });
      }
      // Intentionally retain the entry. `describeChannels()` is the single source of truth
      // for channel health; deleting the entry would silently downgrade the failure to a
      // generic "stopped" descriptor and force callers (e.g. apps/server) to maintain a
      // parallel failure list. `_teardownEntries` skips entries already in a terminal state
      // so we won't double-shutdown the adapter on subsequent runtime.shutdown().
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    this.stopDedupePurgeTimer();
    await this._teardownEntries(Array.from(this.entries.values()));
  }

  private async _teardownEntries(entries: ChannelEntry[]): Promise<void> {
    // Skip entries that already settled into a terminal state — `error` entries were
    // shut down by `startChannel`'s catch block, and `stopped` entries were torn down
    // by an earlier rollback. Re-running shutdown here would double-stop transports
    // and re-trigger any flaky cleanup paths.
    const live = entries.filter((e) => e.state !== 'error' && e.state !== 'stopped');
    for (const e of live) {
      e.state = 'shutting_down';
      e.dispatcher.close();
      e.abortController.abort();
      e.dispatcher.abortAll();
    }
    await Promise.allSettled(live.map((e) => e.dispatcher.drainAll()));
    // Run adapter shutdowns concurrently — a slow adapter (e.g. grammy
    // long-poll waiting to drain) must not block siblings. Per-entry
    // try/catch keeps the failure isolated to that entry's `state`.
    await Promise.allSettled(
      live.map(async (e) => {
        try {
          await e.adapter.shutdown();
          e.state = 'stopped';
        } catch (err) {
          e.state = 'error';
          e.lastErrorAt = new Date();
          e.lastErrorMessage = errorMessage(err);
          this.logger.error(`channel ${e.adapter.channelId} shutdown error`, err);
        }
      }),
    );
  }

  describeChannels(): ChannelDescriptor[] {
    return this.registry.list().map((adapter) => {
      const e = this.entries.get(adapter.channelId);
      if (!e) {
        return { channelId: adapter.channelId, state: 'stopped', inFlightCount: 0 };
      }
      const base = adapter.describe();
      const state = e.state === 'running' ? base.state : e.state;
      return {
        ...base,
        state,
        ...(e.lastErrorAt !== undefined ? { lastErrorAt: e.lastErrorAt } : {}),
        ...(e.lastErrorMessage !== undefined ? { lastErrorMessage: e.lastErrorMessage } : {}),
      };
    });
  }
}

function mergeCommands(
  defaults: ReadonlyArray<CommandOverride>,
  overrides: ReadonlyArray<CommandOverride>,
): ReadonlyArray<CommandOverride> {
  const overrideNames = new Set(overrides.map((o) => o.name));
  const merged = [...defaults.filter((d) => !overrideNames.has(d.name))];
  for (const o of overrides) {
    merged.push(o);
  }
  return merged;
}
