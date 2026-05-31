import type {
  CallLlmFn,
  ConversationRepository,
  GoldpanConfig,
  HandleInputRepos,
} from '@goldpan/core';
import type { ConversationContext } from '@goldpan/core/conversation';
import type { DrizzleDB } from '@goldpan/core/db';
import type { EmbeddingProvider } from '@goldpan/core/embedding';
import type { IntentPluginResult, PluginRegistry } from '@goldpan/core/plugins';
import type { ILogObj, Logger } from 'tslog';

export interface ChannelCapabilities {
  /** Whether the channel supports interactive buttons (e.g. inline keyboards). */
  inlineButtons: boolean;
  /** Whether the channel supports a typing/processing indicator. */
  typingIndicator: boolean;
  /** Whether the channel supports rich formatting (HTML/Markdown). */
  richFormat: boolean;
  /** Maximum length of a single outgoing message in characters; longer payloads must be chunked. */
  maxMessageLength: number;
  /** Whether the channel supports image attachments in the reply payload. */
  images: boolean;
  /** Whether the channel supports custom typing/processing lifecycle hooks. */
  lifecycleHooks: boolean;
}

export interface SessionRef {
  channelId: string;
  accountId: string;
  chatId: string;
  /** When `routingMode === 'per_user'`, the userId is part of the sessionKey */
  userId: string;
  /** Mirrors `InboundMessage.threadId`; appended to sessionKey when present. */
  threadId?: string;
}

export interface InboundMessage {
  channelId: string;
  accountId: string;
  chatId: string;
  userId: string;
  /**
   * Optional authoritative session key for replayed/rehydrated messages whose
   * conversation identity must come from persisted state rather than the
   * current transport actor (for example, Telegram clarify callbacks).
   */
  sessionKeyOverride?: string;
  /**
   * Optional authoritative session ref paired with `sessionKeyOverride`.
   * Replayed callbacks use this to restore routing metadata that no longer
   * exists on the current transport event, such as a Feishu thread id.
   */
  sessionRefOverride?: SessionRef;
  platformMsgId: string;
  text?: string;
  contentType: 'text' | 'image' | 'voice' | 'video' | 'file' | 'other';
  /**
   * True when Layer B is orchestrating a synthetic re-dispatch (clarify
   * replay, card-action callback, etc.). The dispatcher SKIPS FILTERS for
   * these — the originating message already passed every filter when its
   * card / inline-keyboard was sent, and the user's tap is an affirmative
   * follow-up that semantically bypasses mention-gating. Dedupe is KEPT —
   * adapters use deterministic replay ids (`clarify-replay:<msgId>:<idx>`,
   * `card-action-clarify:<msgId>:<idx>`) whose whole point is to deduplicate
   * double-taps into exactly-once processing.
   */
  synthesized?: boolean;
  /**
   * Optional thread / topic id within a chat. When present, the SessionRouter
   * appends `:t=<threadId>` to the sessionKey so parallel threads in one chat
   * get separate conversation state (Phase 2 decision #4 — Feishu uses Lark
   * `event.message.thread_id`; future Slack threads / Telegram topics can ride
   * the same field).
   */
  threadId?: string;
  /**
   * Channel-local raw payload (e.g. grammy `Update` for Telegram). Filters and renderers
   * may inspect this for platform-specific concerns (e.g. is this a DM, a reply-to-bot).
   */
  raw: unknown;
  receivedAt: Date;
  /**
   * P4: clarify keyed callback / IM bound-intent commands 透传给 handleInput，
   * 绕过 classifier。与 dispatcher `runHandleInputTurn({forcedIntent})` 同义，
   * 但前者用于 channel adapter 自己合成的 callback 重放（synthesized）—— 当 adapter
   * 已经在 callback 里解码出 intentKey 时（例如 keyed clarify chip），就不该再
   * "把文字重发给 classifier 重判" 浪费 LLM 调用并增加误判面。
   */
  forcedIntent?: string;
  /**
   * P4: 与 `forcedIntent` 成对透传的不透明 payload —— clarify chip
   * `structuredOptions[i].payload` 由 adapter 一路搬到这里，
   * 再经 dispatcher → handleInput → `IntentExecutionContext.payload` 交给 plugin
   * (例如 resolve_tracking_entity 用它带 ruleId/entityId)。free-text 路径 undefined。
   */
  payload?: string;
}

export type FilterDecision =
  | { type: 'pass' }
  | { type: 'reject' }
  | { type: 'short_circuit'; reply: ChannelReplyPayload };

export interface InboundFilter {
  /** Stable name for logging (`telegram-allowlist`, `telegram-group-mention`, etc). */
  name: string;
  /**
   * Whether this filter should also run for synthesized re-dispatches
   * (clarify-card replays, callback-query taps, etc — `msg.synthesized === true`).
   *
   * Default `true`. Security-class gates (allowlists, rate limits, kill
   * switches) MUST NOT opt out: a chat removed from the allowlist after
   * a card was sent must not be able to drive new turns through stale
   * inline buttons. Only contextual gates whose entire premise is the
   * **originating** message (e.g. group-mention requirements, content-type
   * acceptance) should set this to `false` — the synthesized continuation
   * carries none of those signals by construction and would be silently
   * rejected.
   */
  runOnSynthesized?: boolean;
  /** Pure function — must not call external services. Synchronous to keep ordering deterministic. */
  shouldHandle(msg: InboundMessage): FilterDecision;
}

export interface ParsedCommand {
  /** Canonical command name (e.g. `ask`, `reset`, `help`). */
  name: string;
  /** Everything after the command, trimmed. May be empty. */
  args: string;
  /** Original raw command line including the leading `/`. */
  raw: string;
}

export interface CommandParserOptions {
  /** Bot username (no leading `@`) for stripping `/cmd@bot` suffix and ignoring foreign commands. */
  botUsername?: string;
}

/**
 * Built-in commands recognised by the runtime itself. Their handlers run inside
 * `InboundDispatcher` (no plugin call, no LLM call, no conversation append for
 * the command text — see spec §374-378 "housekeeping commands should not
 * pollute context").
 *
 * - `help`    — channel renders help via `channel.buildHelpReply`
 * - `reset`   — aborts the in-flight turn for this sessionKey, then archives
 *               the active conversation (see spec §1159-1166); channel renders
 *               the confirmation via `channel.buildResetReply`
 * - `release` — P3 minimal buffer UI: find the sessionKey's active
 *               `buffered_wait` message and run `finalizeBuffer` immediately
 *               (forced-intent path), bypassing the maxWaitMs timer. Result
 *               flows through the same `deliverResult` pipeline as a normal
 *               turn so the user sees the actual answer/note/etc. Channel-
 *               agnostic: any IM channel benefits without per-adapter code.
 *               Inline-keyboard form of [Run now] [Cancel] is deferred to P5
 *               (requires Telegram callback_query handler registration).
 * - `cancel`  — P3 minimal buffer UI: find the sessionKey's active
 *               `buffered_wait` message and consume it without invoking
 *               `handleInput` (i.e. drop the deferred work). Replies with a
 *               localized confirmation built via `channel.buildSystemReply`.
 *
 * Note: `/start` is Telegram-specific (Feishu / Lark have no equivalent) and
 * has moved out of the runtime; Telegram registers it as a `commandOverride`
 * with channel-local welcome text.
 */
export type BuiltInCommandName = 'help' | 'reset' | 'release' | 'cancel';

export interface CommandOverride {
  /** Command name to override or add (e.g. `summary`, `share`). */
  name: string;
  /** Description shown by `/help`. */
  description: string;
  /**
   * If set, the dispatcher routes the command's `args` directly to this intent (skipping
   * LLM intent classification). Used for `/ask` → `query`, `/note` → `record_thought`,
   * `/save` → `submit_url`. Mutually exclusive with `builtIn` and with a custom `handle`.
   */
  boundIntent?: string;
  /**
   * Marks this command as runtime-built-in. Built-ins skip the plugin/LLM path entirely;
   * the runtime invokes their `handle` directly (synchronous, returns string), and the
   * dispatcher does NOT append the command text to conversation history.
   */
  builtIn?: BuiltInCommandName;
  /**
   * When `true`, the dispatcher does NOT load/create a conversation or
   * append the command text as a user turn before invoking `handle`.
   * Use for stateless "pure UI" commands like Telegram's channel-local
   * `/start` welcome — they semantically replace the runtime's former
   * housekeeping built-ins and must not pollute conversation history.
   *
   * Default `false`: custom command overrides persist the user turn
   * before invoking the handler so a handler throwing mid-flight still
   * leaves an auditable trace, matching the bound-intent / free-text
   * paths.
   *
   * `ctx.conversation` will be `null` when `noPersist === true`;
   * handlers that need to inspect conversation state should leave this
   * unset.
   *
   * Mutually exclusive with `builtIn` and `boundIntent` (both bypass
   * `runCustomCommand` entirely, where this flag takes effect).
   */
  noPersist?: boolean;
  /**
   * Handler that receives the parsed command + inbound context and returns a reply payload
   * to send directly. Throwing or returning null causes the dispatcher to fall through to
   * default behavior (NOT recommended; if you need fall-through, omit the override).
   * Only used when `boundIntent` and `builtIn` are both absent (i.e. fully custom handler).
   */
  handle?(
    parsed: ParsedCommand,
    msg: InboundMessage,
    ctx: CommandHandlerContext,
  ): Promise<ChannelReplyPayload>;
}

export interface CommandHandlerContext {
  sessionRef: SessionRef;
  sessionKey: string;
  conversation: ConversationContext | null;
  conversationRepo: ConversationRepository;
  logger: Logger<ILogObj>;
  /**
   * Language hint for the command handler — sourced from
   * `IMRuntimeDeps.config.language` via the dispatcher. Custom command
   * overrides (e.g. Telegram's channel-local `/start` welcome) use this for
   * localized replies. Equivalent to `RenderContext.language`.
   */
  language: 'en' | 'zh';
}

/**
 * Opaque payload type. Layer A never inspects fields; each channel defines its
 * own concrete shape (e.g. `TelegramReplyPayload`, `FeishuReplyPayload`) and
 * casts at the channel-internal `sendReply` boundary.
 *
 * Why `unknown` rather than `interface {}`:
 *   - `interface {}` triggers Biome's `lint/suspicious/noEmptyInterface`.
 *   - `interface {}` accepts every non-null value (strings, numbers, Dates …),
 *     so it provides no real type discipline. `unknown` is honest about that.
 *   - Channel-local payload types use plain `interface TelegramReplyPayload { text: string; ... }`
 *     (no `extends ChannelReplyPayload`); the relationship is expressed through
 *     the `ChannelAdapter` method signatures.
 */
export type ChannelReplyPayload = unknown;

export interface InboundStartContext {
  sessionRef: SessionRef;
  sessionKey: string;
  inbound: InboundMessage;
}

export type SendReplyOrigin = 'inbound' | 'outbound';

interface SendReplyContextBase {
  sessionRef: SessionRef;
  sessionKey: string;
  reply: ChannelReplyPayload;
  /** True if this reply chunk is the final one of a multi-message reply. */
  isFinal: boolean;
  origin: SendReplyOrigin;
}

/**
 * Lifecycle context for `onSendReply`. Discriminated on `origin`:
 *   - `inbound`  — reply triggered by an inbound message; `inbound` carries the source message.
 *   - `outbound` — reply initiated by `IMRuntime.sendOutbound`; no inbound message exists.
 */
export type SendReplyContext =
  | (SendReplyContextBase & { origin: 'inbound'; inbound: InboundMessage })
  | (SendReplyContextBase & { origin: 'outbound'; inbound?: undefined });

export interface ChannelLifecycleHooks {
  onProcessingStart?(ctx: InboundStartContext): Promise<void> | void;
  onProcessingEnd?(
    ctx: InboundStartContext,
    result: { ok: boolean; error?: Error },
  ): Promise<void> | void;
  onSendReply?(ctx: SendReplyContext): Promise<void> | void;
}

export interface ChannelAdapter {
  /** Stable channel id, e.g. `telegram`, `slack`. Must equal the `im-<id>` plugin folder name. */
  channelId: string;

  capabilities: ChannelCapabilities;

  /** Account-level filters applied to every inbound message before dedupe. */
  defaultFilters: InboundFilter[];

  /** Channel-local lifecycle hooks (typing indicator, send tracing, etc). */
  lifecycle?: ChannelLifecycleHooks;

  /** Optional command overrides. Merged with the runtime defaults; channel wins on name collision. */
  commandOverrides?: CommandOverride[];

  /** Channel-local renderer for `IntentPluginResult` → `ChannelReplyPayload`. */
  renderResult(
    result: IntentPluginResult,
    ctx: RenderContext,
  ): ChannelReplyPayload | ChannelReplyPayload[];

  /** Channel-local renderer for an i18n error code (e.g. `text_too_long`, `unknown`). */
  renderError(code: string, vars: Record<string, unknown>, ctx: RenderContext): ChannelReplyPayload;

  /**
   * Construct a plain-text system reply for runtime-internal flows:
   *   - Bound-intent missing-args fallback (`Please add text after /ask ...`).
   *
   * Channel translates `text` into its native payload shape so Layer A never
   * has to know about the channel-specific format.
   */
  buildSystemReply(text: string): ChannelReplyPayload;

  /**
   * Called when a user types `/help`. The dispatcher forwards the merged
   * `{commands, intents, language}` so the channel can render its native
   * surface — text for Telegram (via channel-local `formatHelpText`),
   * interactive card for Feishu, etc.
   */
  buildHelpReply(data: {
    commands: ReadonlyArray<{ name: string; description: string }>;
    intents: ReadonlyArray<{ name: string; description: string }>;
    language: 'en' | 'zh';
  }): ChannelReplyPayload;

  /**
   * Called when a user types `/reset`. The dispatcher archives the
   * conversation BEFORE invoking this method; `archived` is true iff an
   * active conversation was archived (false indicates no-op / first-time).
   */
  buildResetReply(data: { archived: boolean; language: 'en' | 'zh' }): ChannelReplyPayload;

  /** Initialize the channel (open polling, set webhooks, etc). Receives runtime APIs in `deps`. */
  start(deps: ChannelStartDeps): Promise<void>;

  /** Stop accepting new inbound messages, drain in-flight ones, release transport resources. */
  shutdown(): Promise<void>;

  /** Returns a JSON-serializable status snapshot for `/health`. */
  describe(): ChannelDescriptor;
}

export interface ChannelDescriptor {
  channelId: string;
  state: 'starting' | 'running' | 'shutting_down' | 'stopped' | 'error';
  account?: { id: string; displayName?: string };
  inFlightCount: number;
  lastErrorAt?: Date;
  lastErrorMessage?: string;
}

export interface RenderContext {
  language: 'en' | 'zh';
  sessionRef: SessionRef;
  /** Per-channel config blob (parsed from env by the runtime). Channel-specific shape. */
  channelConfig: Record<string, unknown>;
  /** Logger scoped to the channel. */
  logger: Logger<ILogObj>;
  /**
   * The `conversation_messages.id` row id created by appending this turn's assistant message,
   * available when a conversation is attached to the dispatch. Renderers that need to round-trip
   * via callback_data (e.g. clarify) embed this id.
   */
  assistantMessageId?: number;
  /** The conversation row id this turn was appended to, when a conversation exists. */
  conversationId?: number;
}

/** Provided by the runtime to each channel adapter at start time. */
export interface ChannelStartDeps {
  /**
   * The channel calls `dispatch(inbound)` for every inbound message it receives. The dispatcher
   * runs filters → dedupe → session routing → command parsing → handleInput → reply. The
   * channel may pre-process some messages (e.g. translate Telegram `callback_query` into a
   * synthetic free-text dispatch) before forwarding here.
   */
  dispatch(msg: InboundMessage): Promise<void>;
  /**
   * The channel MUST call `installSendReply(fn)` exactly once during `start()` to register its
   * outbound transport. The dispatcher uses the installed function for every reply chunk.
   * Calling `dispatch` before `installSendReply` causes the dispatcher to throw on the first
   * reply attempt — adapters should call `installSendReply` before opening the transport.
   */
  installSendReply(fn: (ref: SessionRef, payload: ChannelReplyPayload) => Promise<void>): void;
  /** Allows the channel to provide parser options once platform metadata is available. */
  configureCommandParser(options: CommandParserOptions): void;
  logger: Logger<ILogObj>;
  signal: AbortSignal;
  /**
   * Host language. Sourced from `IMRuntimeDeps.config.language` and forwarded
   * here so adapters can resolve their local i18n without reaching back into
   * `channelConfig` (which is the per-channel env slice — language is host
   * scope, not channel scope).
   */
  language: 'en' | 'zh';
  /** Channel-specific config slice (parsed from env by the runtime, see `IMRuntime.register`). */
  channelConfig: Record<string, unknown>;
  /** Resolved secrets (e.g. bot tokens) the channel asked for via `IMRuntime.register`. */
  secrets: Record<string, string>;
}

export interface IMRuntimeDeps {
  db: DrizzleDB;
  callLlm: CallLlmFn;
  pluginRegistry: PluginRegistry;
  config: GoldpanConfig;
  repos: HandleInputRepos;
  conversationRepo: ConversationRepository;
  embeddingProvider?: EmbeddingProvider | null;
  logger: Logger<ILogObj>;
}
