// monorepo/packages/im-runtime/tests/inbound/dispatcher.test.ts

import { SqliteConversationRepository } from '@goldpan/core';
import { initI18n, resetI18n } from '@goldpan/core/i18n';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConversationStore } from '../../src/conversation/store.js';
import { CommandParser, defaultCommands } from '../../src/inbound/command-parser.js';
import { MessageDedupe } from '../../src/inbound/dedupe.js';
import { InboundDispatcher } from '../../src/inbound/dispatcher.js';
import { SessionRouter } from '../../src/inbound/router.js';
import type { ChannelAdapter, InboundMessage } from '../../src/types.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

// note / tracking_pending 走 core t() 渲染本地化确认文案 → 需先 initI18n
// （extractAssistantTurn 在 ConversationStore.appendAssistantTurn 内被调）。
beforeAll(() => initI18n('en'));
afterAll(() => resetI18n());

/**
 * Concrete reply shape used only by this test harness. `ChannelReplyPayload`
 * is `unknown` (opaque at Layer A); tests want `.text` / `.format` access
 * without per-site casts, so we narrow locally.
 */
interface TestReplyPayload {
  text: string;
  format?: 'plain' | 'html' | 'markdown';
  inlineButtons?: Array<Array<{ label: string; callbackData: string }>>;
}

const makeMsg = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  channelId: 'tg',
  accountId: 'bot',
  chatId: 'c1',
  userId: 'u1',
  platformMsgId: `m-${Math.random()}`,
  text: 'hi',
  contentType: 'text',
  raw: null,
  receivedAt: new Date(),
  ...overrides,
});

interface Harness {
  testDb: TestDB;
  sent: TestReplyPayload[];
  channel: ChannelAdapter;
  dispatcher: InboundDispatcher;
  handleInput: ReturnType<typeof vi.fn>;
  finalizeBufferedMessage: ReturnType<typeof vi.fn>;
}

function buildHarness(
  opts: {
    filters?: ChannelAdapter['defaultFilters'];
    intentDeclarations?: Array<{ name: string; description: string }>;
    handleInputResponse?: unknown;
    handleInputThrows?: Error;
    routingMode?: 'per_chat' | 'per_user';
    /**
     * Optional mock for the dispatcher's `finalizeBufferedMessage` dep — used
     * by `/release` tests. Default mock returns `null` (CAS lost) so tests
     * not exercising release see the "no active buffer" fallback rather
     * than an unhandled undefined.
     */
    finalizeBufferedMessageResponse?: unknown;
  } = {},
): Harness {
  const testDb = createTestDB();
  const repo = new SqliteConversationRepository(testDb.db);
  const store = new ConversationStore({ repo, defaultWindowSize: 8 });
  const dedupe = new MessageDedupe(testDb.db);
  const router = new SessionRouter({ routingMode: opts.routingMode ?? 'per_chat' });
  const parser = new CommandParser({ botUsername: 'mybot' });
  const sent: TestReplyPayload[] = [];
  const send = vi.fn(async (_ref: unknown, payload: unknown) => {
    sent.push(payload as TestReplyPayload);
  });
  const channel: ChannelAdapter = {
    channelId: 'tg',
    capabilities: {
      inlineButtons: false,
      typingIndicator: false,
      richFormat: false,
      maxMessageLength: 4096,
      images: false,
      lifecycleHooks: false,
    },
    defaultFilters: opts.filters ?? [],
    renderResult: vi.fn((r) =>
      r.type === 'content' ? { text: r.text } : { text: `rendered:${r.type}` },
    ),
    renderError: vi.fn((code) => ({ text: `err:${code}` })),
    buildSystemReply: vi.fn((text: string) => ({ text })),
    buildHelpReply: vi.fn(
      (data: {
        commands: ReadonlyArray<{ name: string; description: string }>;
        intents: ReadonlyArray<{ name: string; description: string }>;
        language: 'en' | 'zh';
      }) => ({
        text: 'help-stub',
        format: 'plain' as const,
        structuredCommands: data.commands.map((c) => c.name),
        structuredIntents: data.intents.map((i) => i.name),
        language: data.language,
      }),
    ),
    buildResetReply: vi.fn((data: { archived: boolean; language: 'en' | 'zh' }) => ({
      text: data.archived ? 'reset-stub-archived' : 'reset-stub-noop',
      format: 'plain' as const,
      language: data.language,
    })),
    start: vi.fn(),
    shutdown: vi.fn(),
    describe: vi.fn(() => ({
      channelId: 'tg',
      state: 'running' as const,
      inFlightCount: 0,
    })),
  };
  const handleInput = vi.fn(async () => {
    if (opts.handleInputThrows) throw opts.handleInputThrows;
    return (
      opts.handleInputResponse ?? {
        type: 'content',
        text: 'hello',
        format: 'text',
      }
    );
  });
  const finalizeBufferedMessage = vi.fn(
    async () => (opts.finalizeBufferedMessageResponse ?? null) as never,
  );
  const dispatcher = new InboundDispatcher({
    channel,
    router,
    parser,
    dedupe,
    store,
    conversationRepo: repo,
    handleInput: handleInput as never,
    finalizeBufferedMessage: finalizeBufferedMessage as never,
    sendReply: send,
    overrideCommands: defaultCommands,
    intentDeclarations: opts.intentDeclarations ?? [
      { name: 'query', description: 'Ask a question about the knowledge base' },
      { name: 'record_thought', description: 'Capture a free-form note' },
      { name: 'submit_url', description: 'Save a URL into the knowledge base' },
      {
        name: 'summarize_recent',
        description: 'Summarize recently added knowledge',
      },
    ],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
    renderContextBuilder: () => ({
      language: 'en',
      sessionRef: {
        channelId: 'tg',
        accountId: 'bot',
        chatId: 'c1',
        userId: 'u1',
      },
      channelConfig: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as never,
    }),
  });
  return { testDb, sent, channel, dispatcher, handleInput, finalizeBufferedMessage };
}

/**
 * Rebuild a dispatcher against an existing harness after mutating
 * `h.channel.commandOverrides`. Required because `buildHarness` wires
 * `overrideCommands` at construction time, so adding channel-level
 * overrides afterwards needs a fresh dispatcher to see them. All
 * non-override dependencies are rebuilt from the same `h.testDb` so
 * state (dedupe rows, conversation rows) persists across the swap.
 */
function rebuildDispatcherWithChannelOverrides(h: Harness): void {
  const overrides = h.channel.commandOverrides ?? [];
  h.dispatcher = new InboundDispatcher({
    channel: h.channel,
    router: new SessionRouter({ routingMode: 'per_chat' }),
    parser: new CommandParser({ botUsername: 'mybot' }),
    dedupe: new MessageDedupe(h.testDb.db),
    store: new ConversationStore({
      repo: new SqliteConversationRepository(h.testDb.db),
      defaultWindowSize: 8,
    }),
    conversationRepo: new SqliteConversationRepository(h.testDb.db),
    handleInput: h.handleInput as never,
    finalizeBufferedMessage: h.finalizeBufferedMessage as never,
    sendReply: async (_ref, payload) => {
      h.sent.push(payload as TestReplyPayload);
    },
    overrideCommands: [...defaultCommands, ...overrides],
    intentDeclarations: [],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    renderContextBuilder: () => ({
      language: 'en',
      sessionRef: { channelId: 'tg', accountId: 'bot', chatId: 'c1', userId: 'u1' },
      channelConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    }),
  });
}

describe('InboundDispatcher', () => {
  let h: Harness;
  afterEach(() => h.testDb.cleanup());

  it('happy path: free-text → handleInput → render → send', async () => {
    h = buildHarness();
    await h.dispatcher.dispatch(makeMsg({ text: 'tell me' }));
    expect(h.handleInput).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([{ text: 'hello' }]);
  });

  // P4: keyed clarify callback handler (im-telegram) re-dispatches a
  // synthesized text inbound with `forcedIntent` + `payload` pinned. The
  // dispatcher must thread both onto `handleInput` so the classifier is
  // skipped and the resolved intent plugin sees the chip's payload.
  it('forwards msg.forcedIntent and msg.payload through to handleInput', async () => {
    h = buildHarness();
    await h.dispatcher.dispatch(
      makeMsg({
        text: 'original user input',
        synthesized: true,
        forcedIntent: 'create_note',
        payload: 'opaque-chip-payload',
        platformMsgId: 'forced-1',
      }),
    );
    expect(h.handleInput).toHaveBeenCalledTimes(1);
    const callArg = h.handleInput.mock.calls[0][0] as {
      input: string;
      forcedIntent?: string;
      payload?: string;
    };
    expect(callArg.input).toBe('original user input');
    expect(callArg.forcedIntent).toBe('create_note');
    expect(callArg.payload).toBe('opaque-chip-payload');
  });

  it('filter reject drops the message silently', async () => {
    h = buildHarness({
      filters: [{ name: 'rej', shouldHandle: () => ({ type: 'reject' }) }],
    });
    await h.dispatcher.dispatch(makeMsg());
    expect(h.handleInput).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it('filter short_circuit sends reply without handleInput', async () => {
    h = buildHarness({
      filters: [
        {
          name: 'sc',
          shouldHandle: () => ({
            type: 'short_circuit',
            reply: { text: 'go away' },
          }),
        },
      ],
    });
    await h.dispatcher.dispatch(makeMsg());
    expect(h.handleInput).not.toHaveBeenCalled();
    expect(h.sent).toEqual([{ text: 'go away' }]);
  });

  it('synthesized messages skip filters that opt out via runOnSynthesized=false but keep dedupe', async () => {
    const filterCalls: string[] = [];
    h = buildHarness({
      filters: [
        {
          name: 'context-gated',
          runOnSynthesized: false,
          shouldHandle: (m) => {
            filterCalls.push(m.platformMsgId);
            return { type: 'reject' };
          },
        },
      ],
    });
    await h.dispatcher.dispatch(
      makeMsg({ text: 'replay', platformMsgId: 'syn-1', synthesized: true }),
    );
    expect(filterCalls).toEqual([]); // opt-out filter skipped
    expect(h.handleInput).toHaveBeenCalledTimes(1);

    await h.dispatcher.dispatch(
      makeMsg({ text: 'replay', platformMsgId: 'syn-1', synthesized: true }),
    );
    expect(h.handleInput).toHaveBeenCalledTimes(1); // dedupe still drops repeat
    expect(filterCalls).toEqual([]);
  });

  // Regression: a chat removed from `*_ALLOWED_CHAT_IDS` after a clarify
  // card was sent must not be able to drive new turns through stale
  // inline buttons. Allowlist-style filters DO NOT opt out (no
  // `runOnSynthesized: false`), so the dispatcher MUST still run them
  // on synthesized re-dispatches.
  it('synthesized messages still run filters that did NOT opt out (security default)', async () => {
    const filterCalls: string[] = [];
    h = buildHarness({
      filters: [
        {
          name: 'allowlist',
          // No `runOnSynthesized` field → default true
          shouldHandle: (m) => {
            filterCalls.push(m.platformMsgId);
            return { type: 'reject' };
          },
        },
      ],
    });
    await h.dispatcher.dispatch(
      makeMsg({ text: 'replay-after-removal', platformMsgId: 'syn-2', synthesized: true }),
    );
    expect(filterCalls).toEqual(['syn-2']);
    expect(h.handleInput).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  // Regression: stateless command overrides (Telegram /start, etc.) must
  // not load/create a conversation or persist the command text as a
  // user turn, otherwise `/start` would manufacture a one-line "/start"
  // conversation and the immediately-following `/reset` would flip
  // from a no-op into "archive that synthetic conversation".
  it('custom command override with noPersist=true does NOT load/append a conversation', async () => {
    h = buildHarness();
    let receivedConversation: unknown = 'unset';
    h.channel.commandOverrides = [
      {
        name: 'welcome',
        description: 'Show a welcome message.',
        noPersist: true,
        handle: async (_p, _m, ctx) => {
          receivedConversation = ctx.conversation;
          return { text: 'hi there' };
        },
      },
    ];
    rebuildDispatcherWithChannelOverrides(h);

    await h.dispatcher.dispatch(makeMsg({ text: '/welcome', platformMsgId: 'w1' }));
    expect(receivedConversation).toBeNull();
    expect(h.sent.at(-1)).toEqual({ text: 'hi there' });

    // No conversation row was created, so /reset right after stays a no-op.
    const probe = new SqliteConversationRepository(h.testDb.db);
    expect(probe.loadContext('tg:bot:c1', 8)).toBeNull();

    await h.dispatcher.dispatch(makeMsg({ text: '/reset', platformMsgId: 'r1' }));
    const resetArg = (h.channel.buildResetReply as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(resetArg.archived).toBe(false);
  });

  it('custom command override without noPersist DOES persist the user turn (existing contract)', async () => {
    h = buildHarness();
    h.channel.commandOverrides = [
      {
        name: 'persisted',
        description: 'Custom persisted command.',
        handle: async () => ({ text: 'logged' }),
      },
    ];
    rebuildDispatcherWithChannelOverrides(h);

    await h.dispatcher.dispatch(makeMsg({ text: '/persisted with args', platformMsgId: 'p1' }));
    const probe = new SqliteConversationRepository(h.testDb.db);
    const ctx = probe.loadContext('tg:bot:c1', 8);
    expect(ctx?.recentMessages.map((m) => m.content)).toEqual(['/persisted with args']);
  });

  it('sessionRefOverride is used for sendReply and render context on replayed messages', async () => {
    h = buildHarness();
    await h.dispatcher.dispatch(
      makeMsg({
        text: 'replay',
        platformMsgId: 'syn-thread',
        synthesized: true,
        sessionKeyOverride: 'tg:bot:c1:t=topic-1',
        sessionRefOverride: {
          channelId: 'tg',
          accountId: 'bot',
          chatId: 'c1',
          userId: 'u1',
          threadId: 'topic-1',
        },
      }),
    );
    const handleInputArgs = h.handleInput.mock.calls[0]?.[0] as {
      sessionKey: string;
      sessionRef: { threadId?: string };
    };
    expect(handleInputArgs.sessionKey).toBe('tg:bot:c1:t=topic-1');
    expect(handleInputArgs.sessionRef.threadId).toBe('topic-1');
  });

  it('non-synthesized messages still go through the filter chain', async () => {
    h = buildHarness({
      filters: [{ name: 'rej', shouldHandle: () => ({ type: 'reject' }) }],
    });
    await h.dispatcher.dispatch(makeMsg({ text: 'normal' }));
    expect(h.handleInput).not.toHaveBeenCalled();
  });

  it('dedupe drops a repeat message', async () => {
    h = buildHarness();
    const m = makeMsg({ platformMsgId: 'fixed' });
    await h.dispatcher.dispatch(m);
    await h.dispatcher.dispatch(m);
    expect(h.handleInput).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(1);
  });

  it('dedupe runs BEFORE filters: a repeat short_circuit reply is suppressed', async () => {
    // Regression for "DoS amplification via short_circuit replies": previously
    // a filter that returned `short_circuit` would emit its reply EVERY time
    // the same `platform_msg_id` was redelivered (transport replay, polling
    // cursor rewind, attacker-synthesised duplicates, ...) because dedupe ran
    // AFTER filters. Dedupe now runs first, so the second dispatch is dropped
    // silently and the channel's outbound API quota is protected.
    h = buildHarness({
      filters: [
        {
          name: 'sc',
          shouldHandle: () => ({ type: 'short_circuit', reply: { text: 'go away' } }),
        },
      ],
    });
    const m = makeMsg({ platformMsgId: 'fixed' });
    await h.dispatcher.dispatch(m);
    await h.dispatcher.dispatch(m);
    expect(h.sent).toEqual([{ text: 'go away' }]);
  });

  it('drops commands addressed to a different bot instead of treating them as free text', async () => {
    h = buildHarness();
    await h.dispatcher.dispatch(makeMsg({ text: '/ask@otherbot hi', platformMsgId: 'foreign' }));
    expect(h.handleInput).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it('built-in /reset archives the conversation; the next message starts fresh; reset is NOT in history', async () => {
    h = buildHarness();
    await h.dispatcher.dispatch(makeMsg({ text: 'hi', platformMsgId: 'm1' }));

    const probe = new SqliteConversationRepository(h.testDb.db);
    const ctxBefore = probe.loadContext('tg:bot:c1', 8);
    expect(ctxBefore?.recentMessages).toHaveLength(2);
    const activeIdBefore = ctxBefore!.conversationId;

    await h.dispatcher.dispatch(makeMsg({ text: '/reset', platformMsgId: 'm2' }));
    expect(h.sent.at(-1)?.text).toMatch(/reset|fresh|new/i);
    expect(h.channel.buildResetReply).toHaveBeenCalled();
    const resetArg = (h.channel.buildResetReply as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      archived: boolean;
      language: 'en' | 'zh';
    };
    expect(resetArg.archived).toBe(true);
    expect(resetArg.language).toBe('en');

    const archived = probe.loadConversationById(activeIdBefore);
    expect(archived?.messages.map((m) => m.content)).toEqual(['hi', 'hello']);

    await h.dispatcher.dispatch(makeMsg({ text: 'after reset', platformMsgId: 'm3' }));
    const ctxAfter = probe.loadContext('tg:bot:c1', 8);
    expect(ctxAfter).not.toBeNull();
    expect(ctxAfter!.conversationId).not.toBe(activeIdBefore);
    expect(ctxAfter!.recentMessages.map((m) => m.content)).toEqual(['after reset', 'hello']);
  });

  it('/reset aborts the in-flight handleInput call before archiving (spec §1159-1166)', async () => {
    h = buildHarness();
    let abortObservedSignal: AbortSignal | null = null;
    const turnFinished = vi.fn();
    h.handleInput.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      abortObservedSignal = signal;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          reject(new DOMException('aborted by /reset', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort);
        setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          turnFinished();
          resolve();
        }, 1000);
      });
      return { type: 'content', text: 'long answer', format: 'text' };
    });

    const slow = h.dispatcher.dispatch(
      makeMsg({ text: 'tell me a long story', platformMsgId: 'm1' }),
    );
    await new Promise((r) => setTimeout(r, 5));
    await h.dispatcher.dispatch(makeMsg({ text: '/reset', platformMsgId: 'm2' }));
    await slow;

    expect(abortObservedSignal).not.toBeNull();
    expect(abortObservedSignal!.aborted).toBe(true);
    expect(turnFinished).not.toHaveBeenCalled();
    expect(h.sent.map((p) => p.text).join(' | ')).toMatch(/reset|fresh|new/i);
  });

  it.each([
    ['/ask what is X', 'query', 'what is X'],
    [
      '/note today I learned that hash maps are O(1)',
      'record_thought',
      'today I learned that hash maps are O(1)',
    ],
    ['/save https://example.com/post', 'submit_url', 'https://example.com/post'],
  ])('bound-intent command %s routes to handleInput with forcedIntent=%s and the args as input', async (raw, expectedIntent, expectedInput) => {
    h = buildHarness();
    await h.dispatcher.dispatch(makeMsg({ text: raw, platformMsgId: raw }));
    expect(h.handleInput).toHaveBeenCalledTimes(1);
    const callArg = h.handleInput.mock.calls[0][0] as {
      input: string;
      forcedIntent?: string;
    };
    expect(callArg.input).toBe(expectedInput);
    expect(callArg.forcedIntent).toBe(expectedIntent);
  });

  it('bound-intent command with empty args replies with a friendly hint and does NOT call handleInput', async () => {
    h = buildHarness();
    await h.dispatcher.dispatch(makeMsg({ text: '/ask', platformMsgId: 'empty' }));
    expect(h.handleInput).not.toHaveBeenCalled();
    expect(h.sent.at(-1)?.text).toMatch(/please add|usage|after/i);
  });

  it('built-in /help delegates to channel.buildHelpReply with structured commands + intents', async () => {
    h = buildHarness();
    await h.dispatcher.dispatch(makeMsg({ text: '/help', platformMsgId: 'h' }));
    expect(h.handleInput).not.toHaveBeenCalled();
    expect(h.channel.buildHelpReply).toHaveBeenCalledTimes(1);
    const callArg = (h.channel.buildHelpReply as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      commands: ReadonlyArray<{ name: string }>;
      intents: ReadonlyArray<{ name: string }>;
      language: 'en' | 'zh';
    };
    expect(callArg.commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(['ask', 'note', 'save', 'help', 'reset']),
    );
    expect(callArg.intents.map((i) => i.name)).toContain('summarize_recent');
    expect(callArg.language).toBe('en');
    const probe = new SqliteConversationRepository(h.testDb.db);
    const ctx = probe.loadContext('tg:bot:c1', 8);
    expect(ctx).toBeNull();
  });

  it('handleInput returns error variant → renderError(code) → reply still sent + error turn persisted', async () => {
    h = buildHarness({
      handleInputResponse: {
        type: 'error',
        code: 'text_too_long',
        message: 'too long',
      },
    });
    await h.dispatcher.dispatch(makeMsg({ text: 'x'.repeat(99999) }));
    expect(h.channel.renderError).toHaveBeenCalledTimes(1);
    const renderArgs = (h.channel.renderError as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(renderArgs[0]).toBe('text_too_long');
    expect(renderArgs[1]).toEqual({ message: 'too long' });
    expect(h.sent[0].text).toBe('err:text_too_long');
    const repo = new SqliteConversationRepository(h.testDb.db);
    const ctx = repo.loadContext('tg:bot:c1', 8);
    expect(ctx?.recentMessages.at(-1)?.metadata).toMatchObject({
      resultType: 'error',
      code: 'text_too_long',
    });
  });

  it('handleInput throws unexpected exception → renderError("unknown") → reply still sent', async () => {
    h = buildHarness({ handleInputThrows: new Error('db lost') });
    await h.dispatcher.dispatch(makeMsg({ text: 'x' }));
    const renderArgs = (h.channel.renderError as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(renderArgs[0]).toBe('unknown');
    expect(renderArgs[1].message).toBe('db lost');
    expect(h.sent[0].text).toBe('err:unknown');
  });

  it('one rejected task does not poison the per-session FIFO lock queue (regression)', async () => {
    h = buildHarness();
    let calls = 0;
    h.handleInput.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('first one boom');
      return { type: 'content', text: 'second-ok', format: 'text' };
    });
    await h.dispatcher.dispatch(makeMsg({ chatId: 'c1', platformMsgId: 'a' }));
    await h.dispatcher.dispatch(makeMsg({ chatId: 'c1', platformMsgId: 'b' }));
    expect(calls).toBe(2);
    expect(h.sent.at(-1)?.text).toBe('second-ok');
  });

  it('throws in onProcessingStart / onProcessingEnd hooks do not poison the lock', async () => {
    h = buildHarness();
    h.channel.lifecycle = {
      onProcessingStart: vi.fn(() => {
        throw new Error('start-hook boom');
      }),
      onProcessingEnd: vi.fn(() => {
        throw new Error('end-hook boom');
      }),
    };
    await h.dispatcher.dispatch(makeMsg({ chatId: 'c1', platformMsgId: 'a' }));
    expect(h.handleInput).toHaveBeenCalledTimes(1);
    expect(h.sent[0]?.text).toBe('hello');
    await h.dispatcher.dispatch(makeMsg({ chatId: 'c1', platformMsgId: 'b' }));
    expect(h.handleInput).toHaveBeenCalledTimes(2);
  });

  it('serializes per-sessionKey: two concurrent dispatches run sequentially', async () => {
    h = buildHarness();
    let active = 0;
    let maxActive = 0;
    h.handleInput.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return { type: 'content', text: 'ok', format: 'text' };
    });
    await Promise.all([
      h.dispatcher.dispatch(makeMsg({ platformMsgId: 'a' })),
      h.dispatcher.dispatch(makeMsg({ platformMsgId: 'b' })),
    ]);
    expect(maxActive).toBe(1);
  });

  it('different sessions can run in parallel', async () => {
    h = buildHarness();
    let active = 0;
    let maxActive = 0;
    h.handleInput.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return { type: 'content', text: 'ok', format: 'text' };
    });
    await Promise.all([
      h.dispatcher.dispatch(makeMsg({ chatId: 'c1', platformMsgId: 'a' })),
      h.dispatcher.dispatch(makeMsg({ chatId: 'c2', platformMsgId: 'b' })),
    ]);
    expect(maxActive).toBe(2);
  });

  it('passes prior conversation history to handleInput on the SECOND turn (multi-turn context)', async () => {
    h = buildHarness({
      handleInputResponse: {
        type: 'content',
        text: 'first answer',
        format: 'text',
      },
    });
    await h.dispatcher.dispatch(makeMsg({ text: 'first turn', platformMsgId: 'a' }));

    h.handleInput.mockResolvedValueOnce({
      type: 'content',
      text: 'second answer',
      format: 'text',
    });
    await h.dispatcher.dispatch(makeMsg({ text: 'follow up', platformMsgId: 'b' }));

    // First turn: no prior history.
    const firstArg = h.handleInput.mock.calls[0][0] as {
      conversation: { recentMessages: Array<{ role: string; content: string }> };
    };
    expect(firstArg.conversation.recentMessages).toEqual([]);

    // Second turn: must include the user+assistant pair from turn 1, and must
    // NOT yet contain the in-flight user message ("follow up") — that one only lands in
    // recentMessages on the NEXT turn after the assistant response is appended. This is
    // the implicit contract that prevents the LLM prompt from duplicating the current
    // query as both `<gp_user_query>` and a trailing `<gp_turn>`.
    const secondArg = h.handleInput.mock.calls[1][0] as {
      input: string;
      conversation: { recentMessages: Array<{ role: string; content: string }> };
    };
    expect(secondArg.input).toBe('follow up');
    expect(secondArg.conversation.recentMessages).toHaveLength(2);
    expect(secondArg.conversation.recentMessages.map((m) => m.content)).not.toContain('follow up');
    expect(secondArg.conversation.recentMessages[0]).toMatchObject({
      role: 'user',
      content: 'first turn',
    });
    expect(secondArg.conversation.recentMessages[1]).toMatchObject({
      role: 'assistant',
      content: 'first answer',
    });
  });

  it('passes assistantMessageId + conversationId to renderResult so clarify can round-trip', async () => {
    h = buildHarness({
      handleInputResponse: {
        type: 'clarify',
        question: 'which?',
        options: ['x', 'y'],
      },
    });
    await h.dispatcher.dispatch(makeMsg({ text: 'do something' }));
    expect(h.channel.renderResult).toHaveBeenCalledTimes(1);
    const renderCall = (h.channel.renderResult as ReturnType<typeof vi.fn>).mock.calls[0];
    const renderCtxArg = renderCall[1] as {
      assistantMessageId?: number;
      conversationId?: number;
    };
    expect(renderCtxArg.assistantMessageId).toBeGreaterThan(0);
    expect(renderCtxArg.conversationId).toBeGreaterThan(0);
  });

  it('uses sessionKeyOverride for replayed messages so per_user callbacks stay in the originating session', async () => {
    h = buildHarness({ routingMode: 'per_user' });
    await h.dispatcher.dispatch(
      makeMsg({
        userId: 'owner',
        text: 'first turn',
        platformMsgId: 'm1',
      }),
    );

    await h.dispatcher.dispatch(
      makeMsg({
        userId: 'clicker',
        text: 'picked option',
        sessionKeyOverride: 'tg:bot:c1:owner',
        platformMsgId: 'm2',
      }),
    );

    const secondArg = h.handleInput.mock.calls[1][0] as {
      sessionKey: string;
      conversation: { sessionKey: string; recentMessages: Array<{ content: string }> };
    };
    expect(secondArg.sessionKey).toBe('tg:bot:c1:owner');
    expect(secondArg.conversation.sessionKey).toBe('tg:bot:c1:owner');
    expect(secondArg.conversation.recentMessages.map((m) => m.content)).toEqual([
      'first turn',
      'hello',
    ]);
  });

  // ─── P2 Task 13: wait / note / tracking_pending dispatcher 接线 ──────────
  // 与 server /input UX 一致性的关键回归：wait 不写 assistant turn / 不走 renderResult；
  // P3 起 wait 路径**会** sendReply（buildSystemReply 的 hold prompt），但仍不写
  // assistant turn —— turn 留给 buffer 释放路径（/release / 自动 finalize）补写。
  // note / tracking_pending 写 turn + renderResult 走 channel。
  it('wait result: sends localized hold prompt via buildSystemReply, no renderResult, no assistant turn (P3)', async () => {
    h = buildHarness({
      handleInputResponse: {
        type: 'wait',
        bufferedMessageId: 1,
        expiresAt: Date.now() + 30_000,
        fallbackIntent: 'create_note',
        maxWaitMs: 30_000,
        waitReasonKey: 'incomplete_command',
      },
    });
    await h.dispatcher.dispatch(makeMsg({ text: '明天那个...', platformMsgId: 'w1' }));
    expect(h.handleInput).toHaveBeenCalledTimes(1);
    // 关键 UX 不变量：wait 路径不走 renderResult（不是 IntentPluginResult 渲染）
    expect(h.channel.renderResult).not.toHaveBeenCalled();
    // P3：buildSystemReply 发了一条 hold prompt（提示用户继续 / 用 /release / /cancel）
    expect(h.channel.buildSystemReply).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toMatch(/30s|Waiting|\/release|\/cancel/);
    // user turn 应该被持久化（adapter 在 handleInput 之前 appendUserTurn），但
    // 没有 assistant turn —— buffer 释放路径再补写。
    const probe = new SqliteConversationRepository(h.testDb.db);
    const ctx = probe.loadContext('tg:bot:c1', 8);
    expect(ctx?.recentMessages.map((m) => m.role)).toEqual(['user']);
  });

  it('note result: assistant turn persisted with localized text + renderResult invoked', async () => {
    h = buildHarness({
      handleInputResponse: {
        type: 'note',
        detail: {
          id: 99,
          content: 'remember to refactor classifier',
          contentTranslated: null,
          language: null,
          subtype: 'note',
          pinned: false,
          archived: false,
          sourceMessageId: null,
          tags: [],
          linkedEntities: [],
          linkedSources: [],
          createdAt: 1700000000,
          updatedAt: 1700000000,
        },
      },
    });
    await h.dispatcher.dispatch(
      makeMsg({ text: '记一下：明天改 classifier', platformMsgId: 'n1' }),
    );
    expect(h.channel.renderResult).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.text).toBe('rendered:note');
    // assistant turn 走 core t() 翻译 → 'Saved as note #99'（initI18n('en')）
    const probe = new SqliteConversationRepository(h.testDb.db);
    const ctx = probe.loadContext('tg:bot:c1', 8);
    expect(ctx?.recentMessages.at(-1)?.content).toBe('Saved as note #99');
    expect(ctx?.recentMessages.at(-1)?.metadata).toMatchObject({
      resultType: 'note',
      noteId: 99,
      subtype: 'note',
    });
  });

  it('tracking_pending result: assistant turn persisted with localized text + renderResult invoked', async () => {
    h = buildHarness({
      handleInputResponse: {
        type: 'tracking_pending',
        trackingRuleId: 7,
        reasonKey: 'waiting_pipeline',
      },
    });
    await h.dispatcher.dispatch(makeMsg({ text: '追踪那个项目', platformMsgId: 't1' }));
    expect(h.channel.renderResult).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.text).toBe('rendered:tracking_pending');
    const probe = new SqliteConversationRepository(h.testDb.db);
    const ctx = probe.loadContext('tg:bot:c1', 8);
    expect(ctx?.recentMessages.at(-1)?.content).toBe(
      'Waiting for the source analysis to finish before setting up tracking',
    );
    expect(ctx?.recentMessages.at(-1)?.metadata).toMatchObject({
      resultType: 'tracking_pending',
      trackingRuleId: 7,
      reasonKey: 'waiting_pipeline',
    });
  });

  // ─── P3 Task 14: built-in /release + /cancel for buffered_wait UX ──────────
  // 这两个命令通过 `BuiltInCommandName` 扩展，dispatcher 直接处理（无 plugin / LLM
  // 调用）。/release 调 `finalizeBufferedMessage` 走 forced-intent 路径，结果
  // 走 deliverResult；/cancel 直接 CAS consumeBuffered，回执通过 buildSystemReply。

  /**
   * Seed an active `buffered_wait` message for the test sessionKey.
   * Uses the real conversation repo (already wired into the harness) so
   * the dispatcher's `findActiveBufferedBySession` call hits real SQL.
   */
  function seedBuffer(
    h: Harness,
    sessionKey: string,
    content: string,
    expiresAt = Date.now() + 30_000,
  ): number {
    const repo = new SqliteConversationRepository(h.testDb.db);
    const { id: conversationId } = repo.findOrCreate(sessionKey, 'tg');
    const { id } = repo.appendMessage(conversationId, { role: 'user', content });
    const ok = repo.markBufferedWait(id, expiresAt, { fallbackIntent: 'create_note' });
    expect(ok).toBe(true);
    return id;
  }

  it('Path A merge reloads conversation context after consuming the old buffer', async () => {
    h = buildHarness({
      handleInputResponse: { type: 'content', text: 'merged answer', format: 'text' },
    });
    seedBuffer(h, 'tg:bot:c1', 'incomplete...');

    await h.dispatcher.dispatch(makeMsg({ text: '补充信息', platformMsgId: 'merge-buffer' }));

    expect(h.handleInput).toHaveBeenCalledTimes(1);
    const arg = h.handleInput.mock.calls[0][0] as {
      input: string;
      conversation: { recentMessages: Array<{ content: string; status?: string }> };
    };
    expect(arg.input).toBe('incomplete...\n\n补充信息');
    expect(arg.conversation.recentMessages.map((m) => m.content)).not.toContain('incomplete...');
  });

  it('/release with no active buffer replies via buildSystemReply with the localized "no pending" text', async () => {
    h = buildHarness();
    await h.dispatcher.dispatch(makeMsg({ text: '/release', platformMsgId: 'r0' }));
    expect(h.handleInput).not.toHaveBeenCalled();
    expect(h.finalizeBufferedMessage).not.toHaveBeenCalled();
    expect(h.channel.buildSystemReply).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.text).toMatch(/pending|No pending/);
  });

  it('/release with an active buffer calls finalizeBufferedMessage and pipes the result through deliverResult', async () => {
    h = buildHarness({
      finalizeBufferedMessageResponse: {
        executed: true,
        result: { type: 'content', text: 'finalized!', format: 'text' },
        conversationId: 1,
      },
    });
    const bufferedId = seedBuffer(h, 'tg:bot:c1', 'incomplete...');

    await h.dispatcher.dispatch(makeMsg({ text: '/release', platformMsgId: 'r1' }));

    expect(h.finalizeBufferedMessage).toHaveBeenCalledTimes(1);
    expect(h.finalizeBufferedMessage.mock.calls[0][0]).toBe(bufferedId);
    // Result rendered through the channel pipeline (renderResult, not buildSystemReply)
    expect(h.channel.renderResult).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.text).toBe('finalized!');
  });

  it('/release still finalizes an expired pending buffer before the cron sweeps it', async () => {
    h = buildHarness({
      finalizeBufferedMessageResponse: {
        executed: true,
        result: { type: 'content', text: 'late finalized', format: 'text' },
        conversationId: 1,
      },
    });
    const bufferedId = seedBuffer(h, 'tg:bot:c1', 'expired...', Date.now() - 10_000);

    await h.dispatcher.dispatch(makeMsg({ text: '/release', platformMsgId: 'r-expired' }));

    expect(h.finalizeBufferedMessage).toHaveBeenCalledTimes(1);
    expect(h.finalizeBufferedMessage.mock.calls[0][0]).toBe(bufferedId);
    expect(h.sent.at(-1)?.text).toBe('late finalized');
  });

  it('/release surfaces error results via channel.renderError', async () => {
    h = buildHarness({
      finalizeBufferedMessageResponse: {
        executed: true,
        result: { type: 'error', code: 'invalid_input', message: 'boom' },
        conversationId: 1,
      },
    });
    seedBuffer(h, 'tg:bot:c1', 'incomplete...');

    await h.dispatcher.dispatch(makeMsg({ text: '/release', platformMsgId: 'r2' }));

    expect(h.channel.renderError).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.text).toBe('err:invalid_input');
  });

  it('/release with CAS race (finalizeBufferedMessage returns null) falls back to "no pending" surface', async () => {
    h = buildHarness({ finalizeBufferedMessageResponse: null });
    seedBuffer(h, 'tg:bot:c1', 'incomplete...');

    await h.dispatcher.dispatch(makeMsg({ text: '/release', platformMsgId: 'r3' }));

    expect(h.finalizeBufferedMessage).toHaveBeenCalledTimes(1);
    expect(h.channel.renderResult).not.toHaveBeenCalled();
    expect(h.channel.buildSystemReply).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.text).toMatch(/pending|No pending/);
  });

  it('/cancel with no active buffer replies via buildSystemReply with the localized "no pending" text', async () => {
    h = buildHarness();
    await h.dispatcher.dispatch(makeMsg({ text: '/cancel', platformMsgId: 'c0' }));
    expect(h.handleInput).not.toHaveBeenCalled();
    expect(h.finalizeBufferedMessage).not.toHaveBeenCalled();
    expect(h.channel.buildSystemReply).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.text).toMatch(/pending|No pending/);
  });

  it('/cancel with an active buffer consumes it via CAS and replies with localized "cancelled" text — handleInput NOT called', async () => {
    h = buildHarness();
    const bufferedId = seedBuffer(h, 'tg:bot:c1', 'incomplete...');

    await h.dispatcher.dispatch(makeMsg({ text: '/cancel', platformMsgId: 'c1' }));

    expect(h.handleInput).not.toHaveBeenCalled();
    expect(h.finalizeBufferedMessage).not.toHaveBeenCalled();
    expect(h.channel.buildSystemReply).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.text).toMatch(/Cancelled|cancel/i);
    // Buffer status flipped to consumed → no longer findable as active
    const probe = new SqliteConversationRepository(h.testDb.db);
    expect(probe.findActiveBufferedBySession('tg:bot:c1')).toBeNull();
    // And consumeBuffered on the same id is now a CAS no-op
    expect(probe.consumeBuffered(bufferedId)).toBeNull();
  });

  it('/cancel can consume an expired pending buffer before the cron sweeps it', async () => {
    h = buildHarness();
    const bufferedId = seedBuffer(h, 'tg:bot:c1', 'expired...', Date.now() - 10_000);

    await h.dispatcher.dispatch(makeMsg({ text: '/cancel', platformMsgId: 'c-expired' }));

    expect(h.handleInput).not.toHaveBeenCalled();
    expect(h.finalizeBufferedMessage).not.toHaveBeenCalled();
    expect(h.sent.at(-1)?.text).toMatch(/Cancelled|cancel/i);
    const probe = new SqliteConversationRepository(h.testDb.db);
    expect(probe.consumeBuffered(bufferedId)).toBeNull();
  });

  it('/cancel after /cancel (CAS race fallback): second call sees no active buffer', async () => {
    h = buildHarness();
    seedBuffer(h, 'tg:bot:c1', 'incomplete...');

    await h.dispatcher.dispatch(makeMsg({ text: '/cancel', platformMsgId: 'cc1' }));
    expect(h.sent.at(-1)?.text).toMatch(/Cancelled|cancel/i);

    await h.dispatcher.dispatch(makeMsg({ text: '/cancel', platformMsgId: 'cc2' }));
    expect(h.sent.at(-1)?.text).toMatch(/pending|No pending/);
  });
});
