// monorepo/packages/im-runtime/src/inbound/dispatcher.ts

import type { ConversationRepository, HandleInputResult } from '@goldpan/core';
import { errorMessage } from '@goldpan/core';
import { type ConversationContext, findAndMergeBuffered } from '@goldpan/core/conversation';
import { createTranslator } from '@goldpan/core/i18n';
import type { IntentDeclaration, IntentPluginResult } from '@goldpan/core/plugins';
import type { ILogObj, Logger } from 'tslog';
import type { ConversationStore } from '../conversation/store.js';
import type {
  ChannelAdapter,
  ChannelReplyPayload,
  CommandHandlerContext,
  CommandOverride,
  InboundMessage,
  RenderContext,
  SessionRef,
} from '../types.js';
import type { CommandParser } from './command-parser.js';
import type { MessageDedupe } from './dedupe.js';
import type { SessionRouter } from './router.js';

export interface DispatcherDeps {
  channel: ChannelAdapter;
  router: SessionRouter;
  parser: CommandParser;
  dedupe: MessageDedupe;
  store: ConversationStore;
  conversationRepo: ConversationRepository;
  handleInput(args: {
    input: string;
    conversation: ConversationContext;
    sessionKey: string;
    sessionRef: SessionRef;
    signal: AbortSignal;
    forcedIntent?: string;
    /** P4: 与 forcedIntent 成对透传的 opaque payload，最终落到 IntentExecutionContext.payload。 */
    payload?: string;
    /** P2: id of the user turn the dispatcher just persisted; threaded into core deps. */
    currentUserMessageId?: number;
  }): Promise<HandleInputResult>;
  sendReply(ref: SessionRef, payload: ChannelReplyPayload): Promise<void>;
  overrideCommands: ReadonlyArray<CommandOverride>;
  intentDeclarations: ReadonlyArray<IntentDeclaration>;
  logger: Logger<ILogObj>;
  renderContextBuilder(ref: SessionRef): RenderContext;
  /**
   * P3 buffer release: invoked by the `/release` built-in command to run a
   * buffered_wait message immediately. Production wires this to
   * `core.finalizeBuffer` with the full HandleInputDeps closure; tests inject
   * a mock. Optional so existing test harnesses don't have to wire it just to
   * exercise unrelated paths — but the dispatcher refuses to run `/release`
   * when it's absent (logs + replies via `buildSystemReply`).
   */
  /**
   * P3 Path C reconcile: caller wires this to
   * `reconcileExpiredBufferedBySession` so dispatcher.runOne can finalize any
   * expired buffered_wait in this sessionKey **before** writing the new user
   * turn. Without it, fallback assistant turn races the main classify path
   * and lands out-of-order in the conversation log. Optional so tests that
   * don't exercise the buffered path can omit it.
   */
  reconcileBuffered?(sessionKey: string): Promise<void>;
  finalizeBufferedMessage?(
    messageId: number,
    signal?: AbortSignal,
  ): Promise<{
    executed: boolean;
    result: HandleInputResult | null;
    conversationId: number;
  } | null>;
  /**
   * Language used for the structured `/help` / `/reset` data passed to the
   * channel and for `CommandHandlerContext.language` on custom command
   * overrides. Sourced from `IMRuntimeDeps.config.language`. The dispatcher
   * lives in `im-runtime` (channel-agnostic) and never renders surfaces
   * itself — rendering is always delegated to the channel.
   */
  language?: 'en' | 'zh';
}

interface SessionLockEntry {
  tail: Promise<void>;
}

export class InboundDispatcher {
  private locks = new Map<string, SessionLockEntry>();
  private inflight = new Map<string, AbortController>();
  private closed = false;
  private readonly helpCommands: ReadonlyArray<{ name: string; description: string }>;
  private readonly helpIntents: ReadonlyArray<{ name: string; description: string }>;

  constructor(private deps: DispatcherDeps) {
    this.helpCommands = deps.overrideCommands.map((c) => ({
      name: c.name,
      description: c.description,
    }));
    const boundIntentNames = new Set(
      deps.overrideCommands.flatMap((c) => (c.boundIntent ? [c.boundIntent] : [])),
    );
    this.helpIntents = deps.intentDeclarations
      .filter((decl) => !boundIntentNames.has(decl.name))
      .map((decl) => ({ name: decl.name, description: decl.description }));
  }

  /** Reject new dispatches. Already-queued work continues. */
  close(): void {
    this.closed = true;
  }

  async dispatch(msg: InboundMessage): Promise<void> {
    if (this.closed) {
      this.deps.logger.debug('dispatcher closed, rejecting new message');
      return;
    }

    // 1. Dedupe FIRST — before filters. This is critical: filters that emit a
    //    `short_circuit` reply (e.g. an "unsupported content" warning) would
    //    otherwise be repeatable forever for the same `platform_msg_id`,
    //    burning the channel's outbound API quota on duplicate replies whenever
    //    a transport replays the same update (grammy long-poll cursor rewind,
    //    webhook retry, etc.). Doing the insert up front costs one extra row
    //    for messages we'd ultimately reject — acceptable, the table has its
    //    own TTL purge.
    const isNew = this.deps.dedupe.markIfNew({
      channelId: msg.channelId,
      accountId: msg.accountId,
      chatId: msg.chatId,
      platformMsgId: msg.platformMsgId,
    });
    if (!isNew) {
      this.deps.logger.debug(`dedupe drop ${msg.channelId}:${msg.accountId}:${msg.platformMsgId}`);
      return;
    }

    // 2. Filters — synthesized (Layer B re-dispatch) messages skip filters
    //    that are CONTEXTUAL to the originating inbound (mention gates,
    //    content-type acceptance), but security-class filters still run.
    //
    //    Rationale: the originating message already passed every filter
    //    when its card / inline keyboard was sent, so re-running a
    //    mention-gating filter on a "Yes" tap would silently drop the
    //    follow-up (Phase 1 latent bug). However, allowlist / kill-switch
    //    filters express ongoing authorization that can change between
    //    sends — a chat removed from `*_ALLOWED_CHAT_IDS` after a card
    //    was sent must not be able to drive new turns through stale
    //    inline buttons. Filters opt out per-instance via
    //    `runOnSynthesized = false`; default is true (security-by-default).
    //
    // The ref is built once up front — it's needed by short_circuit replies,
    // the FIFO lock below, and `sessionKeyForRef`. Building `buildSessionKey`
    // then `buildSessionRef` separately would allocate the ref twice.
    const ref = msg.sessionRefOverride ?? this.deps.router.buildSessionRef(msg);

    for (const f of this.deps.channel.defaultFilters) {
      if (msg.synthesized && f.runOnSynthesized === false) continue;
      const decision = f.shouldHandle(msg);
      if (decision.type === 'reject') {
        this.deps.logger.debug(`filter ${f.name} rejected message`);
        return;
      }
      if (decision.type === 'short_circuit') {
        await this.deps.sendReply(ref, decision.reply);
        return;
      }
    }

    // 3. Session routing
    const sessionKey = msg.sessionKeyOverride ?? this.deps.router.sessionKeyForRef(ref);

    // 4. Parse command early — need to know if it's /reset BEFORE entering the FIFO lock
    const text = msg.text ?? '';
    const classified = this.deps.parser.classify(text);
    if (classified.kind === 'foreign') {
      this.deps.logger.debug('ignoring command addressed to a different bot', {
        channelId: msg.channelId,
        accountId: msg.accountId,
        chatId: msg.chatId,
        platformMsgId: msg.platformMsgId,
      });
      return;
    }
    const parsed = classified.kind === 'own' ? classified.command : null;
    const override = parsed ? this.findCommand(parsed.name) : null;
    if (override?.builtIn === 'reset') {
      const ctrl = this.inflight.get(sessionKey);
      if (ctrl && !ctrl.signal.aborted) {
        this.deps.logger.debug('/reset aborting in-flight turn', { sessionKey });
        ctrl.abort('reset');
      }
    }

    // 5. Per-sessionKey serialization (FIFO queue)
    await this.runWithLock(sessionKey, () =>
      this.handleOne(msg, sessionKey, ref, parsed, override),
    );
  }

  private findCommand(name: string): CommandOverride | null {
    return this.deps.overrideCommands.find((c) => c.name === name) ?? null;
  }

  async drainAll(): Promise<void> {
    const tails = Array.from(this.locks.values()).map((e) => e.tail);
    await Promise.allSettled(tails);
  }

  /** Abort all in-flight per-dispatch AbortControllers (used during shutdown). */
  abortAll(): void {
    for (const [_key, ctrl] of this.inflight) {
      if (!ctrl.signal.aborted) ctrl.abort('shutdown');
    }
  }

  private async runWithLock(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(key)?.tail ?? Promise.resolve();
    const tail = prev.catch(() => undefined).then(() => fn());
    this.locks.set(key, { tail });
    try {
      await tail;
    } finally {
      if (this.locks.get(key)?.tail === tail) {
        this.locks.delete(key);
      }
    }
  }

  private async handleOne(
    msg: InboundMessage,
    sessionKey: string,
    ref: SessionRef,
    parsed: ReturnType<CommandParser['parse']>,
    override: CommandOverride | null,
  ): Promise<void> {
    let renderCtx: RenderContext;
    try {
      renderCtx = this.deps.renderContextBuilder(ref);
    } catch (err) {
      this.deps.logger.error('handleOne setup failed; dropping message', {
        err: errorMessage(err),
        sessionKey,
      });
      return;
    }

    const startCtx = { sessionRef: ref, sessionKey, inbound: msg };

    // Lifecycle start hook — isolated
    try {
      await this.deps.channel.lifecycle?.onProcessingStart?.(startCtx);
    } catch (hookErr) {
      this.deps.logger.warn('onProcessingStart hook threw; continuing with dispatch', {
        err: errorMessage(hookErr),
      });
    }

    const ctrl = new AbortController();
    let ok = true;
    let caughtError: Error | undefined;

    try {
      // Built-in commands: runtime-handled, no conversation touched, no LLM call
      if (parsed && override?.builtIn) {
        await this.runBuiltIn(override.builtIn, sessionKey, ref, renderCtx, ctrl, msg);
        return;
      }

      // Bound-intent commands
      if (parsed && override?.boundIntent) {
        const outcome = await this.runBoundIntent(
          parsed,
          override.boundIntent,
          msg,
          sessionKey,
          ref,
          renderCtx,
          ctrl,
        );
        if (!outcome.ok) ok = false;
        return;
      }

      // Custom override commands
      if (parsed && override?.handle) {
        await this.runCustomCommand(parsed, override, msg, sessionKey, ref);
        return;
      }

      // Free text → conversation + handleInput
      //
      // P4: 当 adapter 把 `forcedIntent`/`payload` 钉在 inbound 上时（典型场景：
      // Telegram keyed clarify callback 在 channel adapter 里把 chip 的 intentKey
      // 解码后合成 synthesized 文字 inbound），把它们沿用既有 forcedIntent 通道
      // 透传给 handleInput —— 不再走 classifier 重判，与 P2 bound-intent 同语义。
      const { result, finalRenderCtx } = await this.runHandleInputTurn({
        input: msg.text ?? '',
        sessionKey,
        ref,
        renderCtx,
        ctrl,
        ...(msg.forcedIntent !== undefined ? { forcedIntent: msg.forcedIntent } : {}),
        ...(msg.payload !== undefined ? { payload: msg.payload } : {}),
      });

      if (result.type === 'error') {
        ok = false;
        const reply = this.deps.channel.renderError(
          result.code,
          { message: result.message },
          finalRenderCtx,
        );
        await this.deps.sendReply(ref, reply);
        return;
      }

      // P3: wait result —— send a transient prompt indicating we're holding
      // for more context. NOT an assistant turn (would pollute classifier
      // prompt history on the next inbound). The prompt is rendered via
      // `buildSystemReply` so each channel decides its own surface (plain
      // text on Telegram, ephemeral card on Slack, …). P2 left this branch
      // silent — that limitation is removed now.
      if (result.type === 'wait') {
        this.deps.logger.info('dispatcher: classifier wait — sending IM hold prompt', {
          sessionKey,
          bufferedMessageId: result.bufferedMessageId,
          fallbackIntent: result.fallbackIntent,
          waitReasonKey: result.waitReasonKey,
          expiresAt: result.expiresAt,
        });
        await this.sendWaitIndicator(ref, result.maxWaitMs);
        return;
      }

      await deliverResult({
        channel: this.deps.channel,
        ref,
        sessionKey,
        result,
        renderCtx: finalRenderCtx,
        sendReply: this.deps.sendReply,
        logger: this.deps.logger,
        origin: 'inbound',
        inbound: msg,
      });
    } catch (err) {
      ok = false;
      caughtError = err instanceof Error ? err : new Error(String(err));
      this.deps.logger.error('dispatcher caught unexpected exception', {
        err: caughtError.message,
        stack: caughtError.stack,
      });
      if (caughtError.name === 'AbortError' || ctrl.signal.aborted) {
        this.deps.logger.debug('turn aborted; suppressing error reply', { sessionKey });
      } else {
        const reply = this.deps.channel.renderError(
          'unknown',
          { message: caughtError.message },
          renderCtx,
        );
        try {
          await this.deps.sendReply(ref, reply);
        } catch (sendErr) {
          this.deps.logger.error('failed to send error reply', sendErr);
        }
      }
    } finally {
      try {
        await this.deps.channel.lifecycle?.onProcessingEnd?.(startCtx, {
          ok,
          ...(caughtError !== undefined ? { error: caughtError } : {}),
        });
      } catch (hookErr) {
        this.deps.logger.warn('onProcessingEnd hook threw; ignoring', {
          err: errorMessage(hookErr),
        });
      }
    }
  }

  /**
   * Shared spine for free-text and bound-intent paths: load/create conversation,
   * append the user turn, run `handleInput` under the per-sessionKey
   * AbortController, append the assistant turn, and build the final render
   * context with the assistant message id.
   */
  private async runHandleInputTurn(args: {
    input: string;
    sessionKey: string;
    ref: SessionRef;
    renderCtx: RenderContext;
    ctrl: AbortController;
    forcedIntent?: string;
    payload?: string;
  }): Promise<{ result: HandleInputResult; finalRenderCtx: RenderContext }> {
    let conversation = this.deps.store.loadOrCreate(args.sessionKey, this.deps.channel.channelId);
    // P3 Path C (A5)：先 await reconcile 把 expired buffered finalize 掉，
    // 保证 fallback assistant turn 一定在新 user turn 之前入库。注入点缺失
    // 时跳过（测试 / channel 没 wire core）。
    if (this.deps.reconcileBuffered) {
      try {
        await this.deps.reconcileBuffered(args.sessionKey);
      } catch (err) {
        this.deps.logger.warn('dispatcher: reconcileBuffered failed (continuing)', {
          sessionKey: args.sessionKey,
          err: errorMessage(err),
        });
      }
    }
    // P3 Path A: 在 appendUserTurn 之前合并 active buffered（同 sessionKey 有
    // 未过期 buffer 时）。effectiveInput 既落 conversation_messages.user_turn
    // 也传给 handleInput → classifier 用补全后的语义重新判断 intent。
    const merged = findAndMergeBuffered(args.sessionKey, args.input, {
      repo: this.deps.conversationRepo,
    });
    const effectiveInput = merged.input;
    if (merged.merged) {
      this.deps.logger.debug('dispatcher: merged buffered message', {
        sessionKey: args.sessionKey,
        previousMessageId: merged.previousMessageId,
      });
      conversation = this.deps.store.loadOrCreate(args.sessionKey, this.deps.channel.channelId);
    }
    // P2: capture the just-written user-turn id so handleInput can pin
    // note.sourceMessageId / use it as the wait-branch CAS target.
    const { id: appendedUserMsgId } = this.deps.store.appendUserTurn(
      conversation.conversationId,
      effectiveInput,
    );
    this.inflight.set(args.sessionKey, args.ctrl);
    let result: HandleInputResult;
    try {
      result = await this.deps.handleInput({
        input: effectiveInput,
        conversation,
        sessionKey: args.sessionKey,
        sessionRef: args.ref,
        signal: args.ctrl.signal,
        currentUserMessageId: appendedUserMsgId,
        ...(args.forcedIntent !== undefined ? { forcedIntent: args.forcedIntent } : {}),
        ...(args.payload !== undefined ? { payload: args.payload } : {}),
      });
    } finally {
      if (this.inflight.get(args.sessionKey) === args.ctrl) {
        this.inflight.delete(args.sessionKey);
      }
    }
    // P2: wait result 不写 assistant turn（contract 见 store.extractAssistantTurn），
    // appendAssistantTurn 返回 null。finalRenderCtx 在 wait 路径里走不到 render，
    // assistantMessageId 留 undefined 即可（renderCtx 类型允许）。
    const written = this.deps.store.appendAssistantTurn(conversation.conversationId, result);
    return {
      result,
      finalRenderCtx: {
        ...args.renderCtx,
        ...(written !== null ? { assistantMessageId: written.id } : {}),
        conversationId: conversation.conversationId,
      },
    };
  }

  /**
   * P3 helper: send the localized "still buffering" prompt when classifier
   * returns `wait`. Channel-agnostic — `buildSystemReply` renders the plain
   * text into whatever payload shape the channel uses. Failures are logged
   * but never thrown: the buffer itself is the source of truth, the prompt
   * is a UX nicety.
   */
  private async sendWaitIndicator(ref: SessionRef, maxWaitMs: number): Promise<void> {
    const t = createTranslator(this.deps.language ?? 'en').t;
    const seconds = Math.ceil(maxWaitMs / 1000);
    const text = t('intent_classifier.wait_indicator_im_text', { seconds });
    try {
      await this.deps.sendReply(ref, this.deps.channel.buildSystemReply(text));
    } catch (err) {
      this.deps.logger.warn('dispatcher: failed to send wait indicator (buffer still held)', {
        err: errorMessage(err),
      });
    }
  }

  private async runBuiltIn(
    builtIn: NonNullable<CommandOverride['builtIn']>,
    sessionKey: string,
    ref: SessionRef,
    renderCtx: RenderContext,
    ctrl: AbortController,
    msg: InboundMessage,
  ): Promise<void> {
    const language: 'en' | 'zh' = this.deps.language ?? 'en';
    switch (builtIn) {
      case 'help': {
        const payload = this.deps.channel.buildHelpReply({
          commands: this.helpCommands,
          intents: this.helpIntents,
          language,
        });
        await this.deps.sendReply(ref, payload);
        return;
      }
      case 'reset': {
        const archived = this.deps.conversationRepo.archive(sessionKey, 'user_reset') != null;
        const payload = this.deps.channel.buildResetReply({ archived, language });
        await this.deps.sendReply(ref, payload);
        return;
      }
      case 'release': {
        await this.runReleaseBuiltIn(sessionKey, ref, renderCtx, ctrl, msg);
        return;
      }
      case 'cancel': {
        await this.runCancelBuiltIn(sessionKey, ref, language);
        return;
      }
    }
  }

  /**
   * P3 `/release` built-in: locate the sessionKey's active `buffered_wait`
   * message and run `finalizeBuffer` (forced-intent path). Result is rendered
   * through the same `deliverResult` pipeline as a normal turn — error / wait
   * branches handled identically to `handleOne`. The forced-intent path
   * inside `finalizeBuffer` deliberately bypasses the classifier so wait
   * shouldn't recur, but we still defensively branch to keep behaviour
   * consistent if the underlying intent ever changes.
   */
  private async runReleaseBuiltIn(
    sessionKey: string,
    ref: SessionRef,
    renderCtx: RenderContext,
    ctrl: AbortController,
    msg: InboundMessage,
  ): Promise<void> {
    const t = createTranslator(this.deps.language ?? 'en').t;
    const buf = this.deps.conversationRepo.findPendingBufferedBySession(sessionKey);
    if (!buf) {
      await this.deps.sendReply(
        ref,
        this.deps.channel.buildSystemReply(t('intent_classifier.no_active_buffer')),
      );
      return;
    }
    if (!this.deps.finalizeBufferedMessage) {
      this.deps.logger.error(
        'dispatcher: /release invoked but finalizeBufferedMessage dep missing',
        {
          sessionKey,
          bufferedMessageId: buf.id,
        },
      );
      await this.deps.sendReply(
        ref,
        this.deps.channel.buildSystemReply(t('intent_classifier.no_active_buffer')),
      );
      return;
    }
    const finalized = await this.deps.finalizeBufferedMessage(buf.id, ctrl.signal);
    if (!finalized?.result) {
      // CAS lost (concurrent finalize / cancel won), or handleInput threw
      // inside finalizeBuffer (already logged there). Fall back to the
      // "no active buffer" surface so the user gets a stable confirmation.
      this.deps.logger.info('dispatcher: /release finalize returned no result', {
        sessionKey,
        bufferedMessageId: buf.id,
        finalized: finalized !== null,
      });
      await this.deps.sendReply(
        ref,
        this.deps.channel.buildSystemReply(t('intent_classifier.no_active_buffer')),
      );
      return;
    }
    const result = finalized.result;
    if (result.type === 'error') {
      const reply = this.deps.channel.renderError(
        result.code,
        { message: result.message },
        renderCtx,
      );
      await this.deps.sendReply(ref, reply);
      return;
    }
    if (result.type === 'wait') {
      // Defensive: forced-intent path shouldn't return wait; if it ever
      // does, treat the same as the inbound wait branch — log + silent
      // hold. Don't loop the user back into another wait indicator.
      this.deps.logger.warn(
        'dispatcher: /release returned wait result (unexpected); holding silently',
        {
          sessionKey,
          bufferedMessageId: result.bufferedMessageId,
        },
      );
      return;
    }
    await deliverResult({
      channel: this.deps.channel,
      ref,
      sessionKey,
      result,
      renderCtx,
      sendReply: this.deps.sendReply,
      logger: this.deps.logger,
      origin: 'inbound',
      inbound: msg,
    });
  }

  /**
   * P3 `/cancel` built-in: locate the sessionKey's active `buffered_wait`
   * message and CAS-mark it `consumed` without invoking handleInput. Replies
   * with a localized confirmation. Unlike `/release`, no result rendering
   * happens — cancel is a pure "drop the deferred work" operation.
   */
  private async runCancelBuiltIn(
    sessionKey: string,
    ref: SessionRef,
    language: 'en' | 'zh',
  ): Promise<void> {
    const t = createTranslator(language).t;
    const buf = this.deps.conversationRepo.findPendingBufferedBySession(sessionKey);
    if (!buf) {
      await this.deps.sendReply(
        ref,
        this.deps.channel.buildSystemReply(t('intent_classifier.no_active_buffer')),
      );
      return;
    }
    const consumed = this.deps.conversationRepo.consumeBuffered(buf.id);
    if (!consumed) {
      // CAS race — another finalize/cancel won. Surface the same "no active
      // buffer" text so the user gets stable feedback whichever side raced.
      this.deps.logger.info('dispatcher: /cancel CAS lost (concurrent finalize/cancel)', {
        sessionKey,
        bufferedMessageId: buf.id,
      });
      await this.deps.sendReply(
        ref,
        this.deps.channel.buildSystemReply(t('intent_classifier.no_active_buffer')),
      );
      return;
    }
    await this.deps.sendReply(
      ref,
      this.deps.channel.buildSystemReply(t('intent_classifier.cancelled')),
    );
  }

  private async runBoundIntent(
    parsed: NonNullable<ReturnType<CommandParser['parse']>>,
    boundIntent: string,
    msg: InboundMessage,
    sessionKey: string,
    ref: SessionRef,
    renderCtx: RenderContext,
    ctrl: AbortController,
  ): Promise<{ ok: boolean }> {
    const userInput = parsed.args;
    if (!userInput) {
      await this.deps.sendReply(
        ref,
        this.deps.channel.buildSystemReply(
          `Please add text after /${parsed.name} — e.g. \`/${parsed.name} <your message>\`.`,
        ),
      );
      return { ok: true };
    }
    const { result, finalRenderCtx } = await this.runHandleInputTurn({
      input: userInput,
      sessionKey,
      ref,
      renderCtx,
      ctrl,
      forcedIntent: boundIntent,
    });
    if (result.type === 'error') {
      const reply = this.deps.channel.renderError(
        result.code,
        { message: result.message },
        finalRenderCtx,
      );
      await this.deps.sendReply(ref, reply);
      return { ok: false };
    }
    // P3: wait result —— send the same transient hold prompt as `handleOne`
    // so bound-intent paths surface release/cancel UX too. See `handleOne`
    // for the rationale (no assistant turn, channel chooses the surface).
    if (result.type === 'wait') {
      this.deps.logger.info('dispatcher (bound-intent): classifier wait — sending IM hold prompt', {
        sessionKey,
        bufferedMessageId: result.bufferedMessageId,
        fallbackIntent: result.fallbackIntent,
        waitReasonKey: result.waitReasonKey,
        expiresAt: result.expiresAt,
      });
      await this.sendWaitIndicator(ref, result.maxWaitMs);
      return { ok: true };
    }
    await deliverResult({
      channel: this.deps.channel,
      ref,
      sessionKey,
      result,
      renderCtx: finalRenderCtx,
      sendReply: this.deps.sendReply,
      logger: this.deps.logger,
      origin: 'inbound',
      inbound: msg,
    });
    return { ok: true };
  }

  private async runCustomCommand(
    parsed: NonNullable<ReturnType<CommandParser['parse']>>,
    override: CommandOverride,
    msg: InboundMessage,
    sessionKey: string,
    ref: SessionRef,
  ): Promise<void> {
    // Stateless overrides (`noPersist: true`) replace what used to be
    // runtime built-ins like Telegram's `/start`. Loading or creating a
    // conversation here would manufacture a one-line "/start" turn and
    // turn the next `/reset` from a no-op into "archive that synthetic
    // conversation" — exactly the regression that prompted this flag.
    //
    // For everything else, persist the user turn BEFORE invoking the
    // handler so a mid-flight throw still leaves an auditable trace,
    // matching the bound-intent / free-text paths.
    let conversation: ConversationContext | null = null;
    if (!override.noPersist) {
      conversation = this.deps.store.loadOrCreate(sessionKey, this.deps.channel.channelId);
      this.deps.store.appendUserTurn(conversation.conversationId, parsed.raw);
    }
    const cmdCtx: CommandHandlerContext = {
      sessionRef: ref,
      sessionKey,
      conversation,
      conversationRepo: this.deps.conversationRepo,
      logger: this.deps.logger,
      language: this.deps.language ?? 'en',
    };
    if (!override.handle) {
      throw new Error('CommandOverride.handle is required for custom commands');
    }
    const payload = await override.handle(parsed, msg, cmdCtx);
    await this.deps.sendReply(ref, payload);
  }
}

interface DeliverResultContextBase {
  channel: ChannelAdapter;
  ref: SessionRef;
  sessionKey: string;
  result: IntentPluginResult;
  renderCtx: RenderContext;
  sendReply(ref: SessionRef, payload: ChannelReplyPayload): Promise<void>;
  logger: Logger<ILogObj>;
}

/**
 * Discriminated on `origin` so the type system, not a runtime guard, enforces
 * that `inbound` accompanies inbound deliveries — mirrors `SendReplyContext`
 * in `types.ts`.
 */
export type DeliverResultContext =
  | (DeliverResultContextBase & { origin: 'inbound'; inbound: InboundMessage })
  | (DeliverResultContextBase & { origin: 'outbound'; inbound?: undefined });

/**
 * Render an `IntentPluginResult` via the channel, fire `onSendReply` lifecycle
 * per chunk (hook errors logged & swallowed — delivery must proceed), then send.
 * Shared by `InboundDispatcher` (origin=inbound) and `IMRuntime.sendOutbound`
 * (origin=outbound).
 */
export async function deliverResult(ctx: DeliverResultContext): Promise<void> {
  const rendered = ctx.channel.renderResult(ctx.result, ctx.renderCtx);
  const chunks = Array.isArray(rendered) ? rendered : [rendered];
  for (let i = 0; i < chunks.length; i += 1) {
    const isFinal = i === chunks.length - 1;
    try {
      const hook = ctx.channel.lifecycle?.onSendReply;
      if (hook) {
        const base = {
          sessionRef: ctx.ref,
          sessionKey: ctx.sessionKey,
          reply: chunks[i],
          isFinal,
        };
        if (ctx.origin === 'inbound') {
          await hook({ ...base, origin: 'inbound', inbound: ctx.inbound });
        } else {
          await hook({ ...base, origin: 'outbound' });
        }
      }
    } catch (hookErr) {
      ctx.logger.warn('onSendReply hook threw; continuing with delivery', {
        err: errorMessage(hookErr),
      });
    }
    await ctx.sendReply(ctx.ref, chunks[i]);
  }
}
