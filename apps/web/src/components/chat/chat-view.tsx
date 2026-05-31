'use client';

import type { CitedEntity, ConversationMessage, ConversationSummary } from '@goldpan/web-sdk';
import { GoldpanApiError } from '@goldpan/web-sdk';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type InputActionState, inputAction } from '@/actions/input';
import { ErrorBoundary } from '@/components/error-boundary';
import { Inspector } from '@/components/inspector/inspector';
import type { InspectorPayload } from '@/components/inspector/payloads/types';
import { useReclassifyNote } from '@/hooks/use-reclassify-note';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { mapRejectCodeToText } from '@/lib/reject-code-i18n';
import { rethrowNextErrors } from '@/lib/rethrow';
import { WEB_SESSION_KEY } from '@/lib/session';
import { ChatDefault } from './chat-default';
import { ChatHeader } from './chat-header';
import { ChatInput } from './chat-input';
import { MessageList } from './message-list';

type ChatResultType = Exclude<NonNullable<InputActionState['type']>, 'wait'>;

export interface ChatMessage {
  id: string;
  /** P3 buffer mechanism: server-side numeric id, only set for messages loaded
   * from the DB (id prefix `db-${dbMessageId}`). BufferedWaitIndicator needs
   * this numeric id to call POST /conversations/buffered/:id/{release,cancel}.
   * Optimistic `msg-`-prefixed messages haven't been persisted yet, so this
   * stays undefined for them. */
  dbMessageId?: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Which result type populated this message (set for assistant messages). */
  resultType?: ChatResultType;
  queryResult?: {
    answer: string;
    confidence: 'high' | 'medium' | 'low' | 'no_data';
    citedEntities?: CitedEntity[];
  };
  submitResult?: {
    status: 'accepted' | 'duplicate' | 'rejected';
    taskId?: string;
    reason?: string;
    warnings?: string[];
    /** Set on accepted opinion submissions so message-bubble can pick
     * NoteBubbleCard instead of the default TaskBubbleCard. */
    inputMode?: 'fact' | 'opinion';
    /** Duplicate-only: drives DuplicateBubbleCard's deep-link buttons. */
    existingTaskId?: number | null;
    existingSourceId?: number;
    existingUrl?: string;
  };
  contentResult?: {
    text: string;
    format?: 'text' | 'markdown';
    title?: string;
  };
  actionResult?: {
    message: string;
    actionId?: string;
  };
  clarifyResult?: {
    question?: string;
    options?: string[];
    /** P4 (P2 keyed shape): `intent_classifier.clarify_question.<questionKey>` lookup. */
    questionKey?: string;
    /** P4: structured chip metadata — `intentKey` drives dispatch, `payload`
     * passes opaque per-chip context (e.g. tracking entity id) to the plugin. */
    structuredOptions?: Array<{ intentKey: string; payload?: string }>;
  };
  /** P5: server `intent-note` plugin result. MessageBubble case 'note' renders
   * ReclassifyChipBar from this — `noteId` + `subtype` are server-authoritative,
   * `originalUserContent` (separate field) carries the user turn so the chip
   * bar can dispatch forcedIntent on reclassify. */
  noteResult?: {
    noteId: number;
    subtype: 'memo' | 'note';
  };
  /** P5: for note (N5 reclassify) / clarify chip click — preserved at convert
   * time so MessageBubble can pass the original user input back to forcedIntent.
   * Set by convertConversationMessagesToChat (reload path) and the runIntent
   * success handler (live path). */
  originalUserContent?: string;
  pending?: boolean;
  /** P3 buffer mechanism: buffered_wait → consumed lifecycle exposed by
   * GET /conversations/:id. Absent / `'normal'` for non-buffered messages. */
  status?: 'normal' | 'buffered_wait' | 'consumed';
  /** P3: epoch ms when the buffered window expires. Only meaningful when
   * `status === 'buffered_wait'`. Drives the BufferedWaitIndicator countdown. */
  bufferedExpiresAt?: number;
  /** P3: passthrough for server-side message metadata (e.g. `waitReasonKey`
   * for buffered_wait status). BufferedWaitIndicator reads
   * `metadata.waitReasonKey` to render the localized reason text. */
  metadata?: Record<string, unknown>;
}

export interface InitialConversation {
  id: number;
  messages: ConversationMessage[];
  archived: boolean;
}

function nextMessageId(): string {
  return `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

type DbMessageMeta = {
  resultType?: ChatMessage['resultType'];
  submitStatus?: 'accepted' | 'duplicate' | 'rejected';
  taskId?: number;
  rejectCode?: string;
  rejectReason?: string;
  inputMode?: 'fact' | 'opinion';
  /** Duplicate-only: persisted by /input handler so reloads can re-render
   * the rich DuplicateBubbleCard without re-running submit. */
  existingTaskId?: number | null;
  existingSourceId?: number;
  existingUrl?: string;
  confidence?: 'high' | 'medium' | 'low' | 'no_data';
  citedEntities?: CitedEntity[];
  /** P4: deferred resolver / P2 keyed clarify — server writes assistant turns
   * with `questionKey` + `structuredOptions` so reloads can rebuild the
   * interactive chip card without re-running the classifier. */
  questionKey?: string;
  structuredOptions?: Array<{ intentKey: string; payload?: string }>;
  /** P5: persisted by /input route case 'note' (server main.ts ~913-924) —
   * used to rebuild note bubble + ReclassifyChipBar on reload. */
  noteId?: number;
  subtype?: 'memo' | 'note';
};

/**
 * Convert a DB-persisted conversation message to a ChatMessage. Assistant
 * messages for `error` / `submit` are stored as English sentinels + metadata
 * (server is UI-locale-agnostic), so we translate here using the same i18n
 * keys the live response flow uses — keeping reload rendering consistent with
 * what the user originally saw.
 */
function convertDbMessageToChatMessage(
  msg: ConversationMessage,
  tChat: (key: string, values?: Record<string, string | number>) => string,
  tActions: (key: string, values?: Record<string, string | number>) => string,
  maxInputLength: number,
): ChatMessage {
  const meta = (msg.metadata as DbMessageMeta | null) ?? null;
  const resultType = meta?.resultType;

  let content = msg.content;
  let submitResult: ChatMessage['submitResult'];
  let queryResult: ChatMessage['queryResult'];
  let clarifyResult: ChatMessage['clarifyResult'];
  let noteResult: ChatMessage['noteResult'];
  if (msg.role === 'assistant') {
    if (resultType === 'clarify') {
      // P4 reload-time restoration: deferred resolver writes assistant turns
      // with `questionKey` + `structuredOptions` metadata so the chip card
      // re-renders identically on refresh. `msg.content` carries the human
      // question text (legacy free-text fallback when `questionKey` absent).
      clarifyResult = {
        question: msg.content,
        ...(meta?.questionKey !== undefined && { questionKey: meta.questionKey }),
        ...(meta?.structuredOptions !== undefined && {
          structuredOptions: meta.structuredOptions,
        }),
      };
    } else if (resultType === 'query') {
      // Reload-time restoration: server persists hydrated citations + confidence
      // so the rich QueryResultCard re-renders identically. Falls back to
      // `no_data` + empty chips when meta is missing (older messages predating
      // the enriched persistence).
      queryResult = {
        answer: msg.content,
        confidence: meta?.confidence ?? 'no_data',
        citedEntities: meta?.citedEntities ?? [],
      };
    } else if (resultType === 'error') {
      content = tChat('error_message_placeholder');
    } else if (resultType === 'submit' && meta?.submitStatus) {
      if (meta.submitStatus === 'accepted') {
        content = tChat('submit_accepted', { taskId: meta.taskId ?? '' });
      } else if (meta.submitStatus === 'duplicate') {
        content = tChat('submit_duplicate');
      } else {
        content =
          mapRejectCodeToText(meta.rejectCode, tActions, maxInputLength) ??
          meta.rejectReason ??
          tChat('submit_rejected');
      }
      // Repopulate `submitResult` for accepted (rich task bubble re-fetches via
      // polling) and duplicate (rich DuplicateBubbleCard) reloads. Rejected
      // reloads stay plain text — `content` already carries the i18n-mapped
      // reason and SubmitResultCard would otherwise re-render the raw server
      // reason from `meta.rejectReason`.
      if (meta.submitStatus === 'accepted' && typeof meta.taskId === 'number') {
        submitResult = {
          status: 'accepted',
          taskId: String(meta.taskId),
          ...(meta.inputMode !== undefined && { inputMode: meta.inputMode }),
        };
      } else if (meta.submitStatus === 'duplicate' && typeof meta.existingSourceId === 'number') {
        submitResult = {
          status: 'duplicate',
          existingTaskId: meta.existingTaskId ?? null,
          existingSourceId: meta.existingSourceId,
          existingUrl: meta.existingUrl,
        };
      }
    } else if (resultType === 'note' && meta?.noteId !== undefined && meta?.subtype !== undefined) {
      // P5: keep `content` = msg.content (server already wrote the localized
      // "Saved as note #X" sentinel). MessageBubble case 'note' renders the
      // ReclassifyChipBar from `noteResult`; `originalUserContent` is bound
      // separately by convertConversationMessagesToChat (sliding user/assistant
      // pair) so the chip can dispatch forcedIntent on reclassify.
      // P5 Fix Batch 6 (M2): require BOTH noteId + subtype to be present —
      // old fallback `meta.subtype ?? 'note'` masked mislabeling for older
      // persisted messages predating subtype metadata. Without subtype we
      // skip ChipBar entirely (`noteResult` stays undefined) so the bubble
      // falls through to plain assistant text instead of fabricating a wrong
      // subtype chip.
      noteResult = {
        noteId: meta.noteId,
        subtype: meta.subtype,
      };
    }
  }

  return {
    id: `db-${msg.id}`,
    // P3: preserve the numeric DB id so BufferedWaitIndicator can call
    // releaseBufferedMessage / cancelBufferedMessage. Only DB-backed messages
    // expose this; optimistic `msg-`-prefixed messages stay undefined.
    dbMessageId: msg.id,
    role: msg.role,
    content,
    timestamp: new Date(msg.createdAt).getTime(),
    resultType,
    submitResult,
    queryResult,
    clarifyResult,
    ...(noteResult !== undefined && { noteResult }),
    // P3 buffer state — only set when present on the wire so the resulting
    // ChatMessage stays minimal for non-buffered messages.
    ...(msg.status !== undefined && { status: msg.status }),
    ...(msg.bufferedExpiresAt !== undefined && { bufferedExpiresAt: msg.bufferedExpiresAt }),
    ...(msg.metadata !== null && { metadata: msg.metadata }),
  };
}

/**
 * P5: wrap convertDbMessageToChatMessage with sliding (user, assistant) pair
 * tracking so `originalUserContent` can be pre-bound at convert time for
 * resultType=note (N5 ReclassifyChipBar) and resultType=clarify (Task 10
 * future chip dispatch). MessageBubble reads `message.originalUserContent`
 * via a simple inline helper — no array reverse-walk at render time.
 */
function convertConversationMessagesToChat(
  rawMessages: ConversationMessage[],
  tChat: (key: string, values?: Record<string, string | number>) => string,
  tActions: (key: string, values?: Record<string, string | number>) => string,
  maxInputLength: number,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pendingUser: ChatMessage | null = null;
  for (const m of rawMessages) {
    const cm = convertDbMessageToChatMessage(m, tChat, tActions, maxInputLength);
    if (cm.role === 'user') {
      pendingUser = cm;
      out.push(cm);
    } else {
      if (pendingUser && (cm.resultType === 'note' || cm.resultType === 'clarify')) {
        cm.originalUserContent = pendingUser.content;
      }
      out.push(cm);
    }
  }
  return out;
}

const MAX_MESSAGES = 200;

function fingerprintInitialConversation(conversation?: InitialConversation | null): string {
  if (!conversation) return 'none';
  const messages = conversation.messages
    .map((m) =>
      [
        m.id,
        m.role,
        m.status ?? '',
        m.bufferedExpiresAt ?? '',
        String(m.createdAt),
        m.content,
        JSON.stringify(m.metadata ?? null),
      ].join(':'),
    )
    .join('|');
  return `${conversation.id}:${conversation.archived}:${messages}`;
}

export function ChatView({
  maxInputLength,
  initialConversation,
  showDeletedNotice = false,
  showReclassifyFallbackNotice = false,
  prefillQuery,
}: {
  maxInputLength: number;
  initialConversation?: InitialConversation | null;
  /** When true, the last action redirected home because the target conversation
   * was deleted/archived/cross-channel. Show a one-shot info banner and clear
   * the `?deleted=1` query param so refresh doesn't re-trigger it. */
  showDeletedNotice?: boolean;
  /** One-shot notice after reclassify fallback navigates to a new conversation. */
  showReclassifyFallbackNotice?: boolean;
  /** Initial textarea content sourced from `?q=` (Library empty-state
   * suggestion cards). Loaded once on mount, then the URL is cleaned so a
   * refresh doesn't re-apply the prefill on top of the user's edits. */
  prefillQuery?: string;
}) {
  const router = useRouter();
  const tChat = useTranslations('chat');
  const tActions = useTranslations('actions');
  const tInspector = useTranslations('inspector');
  const initialConversationId = initialConversation?.id ?? null;
  const initialConversationVersion = fingerprintInitialConversation(initialConversation);
  const initialMessages = useMemo(
    () =>
      initialConversation
        ? convertConversationMessagesToChat(
            initialConversation.messages,
            tChat,
            tActions,
            maxInputLength,
          )
        : [],
    [initialConversation, maxInputLength, tActions, tChat],
  );
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [currentConversationId, setCurrentConversationId] = useState<number | null>(
    initialConversationId,
  );
  const [isUnarchiving, setIsUnarchiving] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [infoBanner, setInfoBanner] = useState<string | null>(null);
  const didConsumeDeletedNoticeRef = useRef(false);
  const didConsumeReclassifyFallbackNoticeRef = useRef(false);
  const [recentConversations, setRecentConversations] = useState<ConversationSummary[]>([]);
  // PR #57 F-LISTCONV-NO-UI: when listConversations fails on the truly-empty
  // state the original code only `console.error`-ed; UI silently rendered an
  // empty recent list. A small inline hint gives the self-host operator a
  // visible signal without throwing into the chat surface.
  const [recentConversationsFailed, setRecentConversationsFailed] = useState(false);
  const errorBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const infoBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didUnarchiveRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const userMessageCount = useMemo(
    () => messages.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0),
    [messages],
  );
  /** Prevents duplicate optimistic bubbles if the form action runs re-entrantly (e.g. Strict Mode). */
  const actionInFlightRef = useRef(false);
  const [scrollTrigger, setScrollTrigger] = useState(0);
  // `prefillQuery` is read ONCE at mount. Production paths re-key ChatView
  // on `initialConversation?.id`, so a different prefill arrives via a
  // remount rather than a prop diff — if a future caller passes a new
  // prefill without changing the key, the textarea will not refresh.
  const [inputValue, setInputValue] = useState(prefillQuery ?? '');
  const didConsumePrefillRef = useRef(false);
  const [inspectorPayload, setInspectorPayload] = useState<InspectorPayload | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastSyncedInitialVersionRef = useRef(initialConversationVersion);
  // P5 Fix Batch 5 (I3): per-session client memory of "我已经 reclassify 过哪些
  // noteId"。archive 不改 conversation_messages 行，server-side reload 仍然会
  // 把 metadata.noteId 还原为 note bubble + ChipBar，导致用户能重复点击纠错
  // (实测：第二次点会因 note 已 archived 报错)。记下来后渲染时跳过 ChipBar
  // 并显示"已重新分类"提示。F5 全刷会丢这个 set —— 服务端 flag 是更深的修法、
  // 超出本 PR 范围。
  const [reclassifiedNoteIds, setReclassifiedNoteIds] = useState<Set<number>>(new Set());

  // Next router.refresh() re-fetches server props without remounting this
  // client component when the conversation id stays the same. Keep local chat
  // state in sync so server-written assistant turns become visible.
  useEffect(() => {
    if (lastSyncedInitialVersionRef.current === initialConversationVersion) return;
    lastSyncedInitialVersionRef.current = initialConversationVersion;
    setCurrentConversationId(initialConversationId);
    setMessages(initialMessages);
  }, [initialConversationId, initialConversationVersion, initialMessages]);

  // errorBanner auto-hide after 5s; cleanup on unmount / next banner.
  useEffect(() => {
    if (!errorBanner) return;
    if (errorBannerTimerRef.current) clearTimeout(errorBannerTimerRef.current);
    errorBannerTimerRef.current = setTimeout(() => setErrorBanner(null), 5000);
    return () => {
      if (errorBannerTimerRef.current) clearTimeout(errorBannerTimerRef.current);
    };
  }, [errorBanner]);

  // infoBanner auto-hide after 5s (same pattern as errorBanner).
  useEffect(() => {
    if (!infoBanner) return;
    if (infoBannerTimerRef.current) clearTimeout(infoBannerTimerRef.current);
    infoBannerTimerRef.current = setTimeout(() => setInfoBanner(null), 5000);
    return () => {
      if (infoBannerTimerRef.current) clearTimeout(infoBannerTimerRef.current);
    };
  }, [infoBanner]);

  // Show a one-shot info banner after inputAction redirects home because the
  // target conversation was deleted/archived/cross-channel. Clear `?deleted=1`
  // from the URL so a refresh doesn't re-trigger the notice.
  useEffect(() => {
    if (!showDeletedNotice) return;
    if (didConsumeDeletedNoticeRef.current) return;
    didConsumeDeletedNoticeRef.current = true;
    setInfoBanner(tChat('conversation_deleted'));
    router.replace(currentConversationId !== null ? `/?c=${currentConversationId}` : '/');
  }, [currentConversationId, showDeletedNotice, router, tChat]);

  useEffect(() => {
    if (!showReclassifyFallbackNotice) return;
    if (didConsumeReclassifyFallbackNoticeRef.current) return;
    didConsumeReclassifyFallbackNoticeRef.current = true;
    setInfoBanner(tChat('reclassify_fallback_session'));
    router.replace(currentConversationId !== null ? `/?c=${currentConversationId}` : '/');
  }, [currentConversationId, showReclassifyFallbackNotice, router, tChat]);

  // One-shot consumption of `?q=` prefill from Library suggestion cards.
  // Clears the query param so a refresh doesn't keep re-stamping the same
  // text over whatever the user has typed since. `prefillQuery` already
  // populates the initial state — this effect only handles URL hygiene
  // and focus.
  useEffect(() => {
    if (!prefillQuery) return;
    if (didConsumePrefillRef.current) return;
    didConsumePrefillRef.current = true;
    textareaRef.current?.focus();
    // Move caret to end so the user can keep typing immediately after the prefill.
    const node = textareaRef.current;
    if (node) node.setSelectionRange(node.value.length, node.value.length);
    router.replace(currentConversationId !== null ? `/?c=${currentConversationId}` : '/');
  }, [prefillQuery, currentConversationId, router]);

  // Mount unarchive: if `initialConversation` is archived, trigger unarchive once.
  useEffect(() => {
    if (!initialConversation?.archived) return;
    if (didUnarchiveRef.current) return;
    didUnarchiveRef.current = true;
    const targetId = initialConversation.id;
    setIsUnarchiving(true);
    getBrowserApiClient()
      .unarchiveConversation(targetId)
      .then(() => {
        setInfoBanner(tChat('switched_conversation'));
      })
      .catch((err) => {
        const status = err instanceof GoldpanApiError ? err.status : undefined;
        if (status === 404 || status === 403) {
          router.replace('/');
          return;
        }
        setErrorBanner(tChat('unarchive_error'));
      })
      .finally(() => setIsUnarchiving(false));
  }, [initialConversation?.id, initialConversation?.archived, router, tChat]);

  // Recent 3: true-empty state (no messages + no current conversation) triggers fetch.
  const isTrueEmpty = messages.length === 0 && currentConversationId === null;
  useEffect(() => {
    if (!isTrueEmpty) {
      setRecentConversations([]);
      return;
    }
    getBrowserApiClient()
      .listConversations({ channelId: 'web', limit: 3, includeActive: false })
      .then((res) => {
        setRecentConversations(res.items);
        // F-LISTCONV-NO-UI: clear stale failure flag on a fresh successful
        // load (e.g. user switches back to true-empty after a transient err).
        setRecentConversationsFailed(false);
      })
      .catch((err) => {
        // 静默降级为空 recent，但仍 log 让 self-host 调试可见 + 内联 UI 提示
        // 让用户知道"最近对话"区刻意空着不是因为没有历史。
        setRecentConversationsFailed(true);
        console.error('[chat-view] failed to load recent conversations', err);
      });
  }, [isTrueEmpty]);

  const [isCreatingNew, setIsCreatingNew] = useState(false);

  const handleNewConversation = async () => {
    if (isUnarchiving || isCreatingNew || isReclassifying || actionInFlightRef.current) return;
    setIsCreatingNew(true);
    try {
      const { id } = await getBrowserApiClient().createNewConversation('web');
      setCurrentConversationId(id);
      setMessages([]);
      router.replace(`/?c=${id}`);
    } catch (err) {
      // Self-host debug: log the failure cause so the deployer can read it from
      // the browser console / server logs — empty `catch {}` leaves a "无法新
      // 建对话" banner with zero context.
      console.error('[ChatView] createNewConversation failed', err);
      rethrowNextErrors(err);
      setErrorBanner(tChat('new_conversation_error'));
    } finally {
      setIsCreatingNew(false);
    }
  };

  const handleRecentClick = (id: number) => {
    if (isReclassifying) return;
    router.push(`/?c=${id}`);
  };

  // P3 buffer mechanism: invoked when the user clicks "立即执行" inside
  // BufferedWaitIndicator, or when the indicator's auto-release timer fires
  // ~500ms before expiresAt. CAS success → server finalizes the buffered
  // turn and writes the assistant reply; CAS failure (already_finalized)
  // means another tab / timer beat us to it, but the local view is stale
  // either way, so refresh in both branches. router.refresh() re-runs the
  // server component which re-fetches the conversation (same pattern as
  // accepted-submit at line ~452).
  const handleReleaseBuffered = useCallback(
    async (messageId: number) => {
      try {
        await getBrowserApiClient().releaseBufferedMessage(messageId);
      } catch (err) {
        // PR #57 F-BUFFERED-ERR-CODE: server discriminates by error code.
        // `forbidden_cross_channel` (403) — the buffered message belongs to a
        // non-web channel; show a channel-specific banner rather than the
        // generic "could not process" message that would confuse the user.
        // `conversation_archived` (409) — race between the user clicking
        // release and a background archive; soft-refresh so the indicator
        // disappears alongside the archived conversation. Other errors fall
        // through to the generic banner. Note: `already_finalized` is NOT
        // an error path — server returns 200 + `executed: false`, handled
        // by the success branch below (router.refresh picks up the new state).
        if (err instanceof GoldpanApiError) {
          if (err.code === 'forbidden_cross_channel') {
            setErrorBanner(tChat('buffered_cross_channel'));
            return;
          }
          if (err.code === 'conversation_archived') {
            router.refresh();
            return;
          }
        }
        console.error('release buffered failed', err);
        setErrorBanner(tChat('intent_error'));
        return;
      }
      router.refresh();
    },
    [router, tChat],
  );

  // P3 buffer mechanism: invoked when the user clicks "取消" inside
  // BufferedWaitIndicator. Always refresh on success so the message status
  // flips from buffered_wait → consumed badge.
  const handleCancelBuffered = useCallback(
    async (messageId: number) => {
      try {
        await getBrowserApiClient().cancelBufferedMessage(messageId);
      } catch (err) {
        // PR #57 F-BUFFERED-ERR-CODE: mirror handleReleaseBuffered's
        // discrimination. `already_finalized` is a 200 response field, not
        // a thrown error, so it doesn't need a branch here either.
        if (err instanceof GoldpanApiError) {
          if (err.code === 'forbidden_cross_channel') {
            setErrorBanner(tChat('buffered_cross_channel'));
            return;
          }
          if (err.code === 'conversation_archived') {
            router.refresh();
            return;
          }
        }
        console.error('cancel buffered failed', err);
        setErrorBanner(tChat('intent_error'));
        return;
      }
      router.refresh();
    },
    [router, tChat],
  );

  const [, action, isPending] = useActionState<InputActionState, FormData>(
    async (_prevState, formData) => {
      const rawInput = formData.get('input');
      if (typeof rawInput !== 'string' || !rawInput.trim()) return {};

      if (actionInFlightRef.current) return {};
      actionInFlightRef.current = true;

      // Attach sessionKey / conversationId so /input can persist this turn.
      // Also forward the configured text limit so error toasts quote the
      // same number the server enforces (web and server are separate
      // processes with independent env loaders).
      formData.append('sessionKey', WEB_SESSION_KEY);
      formData.append('maxInputLength', String(maxInputLength));
      if (currentConversationId !== null) {
        formData.append('conversationId', String(currentConversationId));
      }

      try {
        // Add user bubble + pending assistant bubble
        const userMsg: ChatMessage = {
          id: nextMessageId(),
          role: 'user',
          content: rawInput.trim(),
          timestamp: Date.now(),
        };
        const pendingMsg: ChatMessage = {
          id: nextMessageId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          pending: true,
        };
        setMessages((prev) => {
          const updated = [...prev, userMsg, pendingMsg];
          return updated.length > MAX_MESSAGES ? updated.slice(-MAX_MESSAGES) : updated;
        });
        setScrollTrigger((prev) => prev + 1);

        // Call server action
        let result: InputActionState;
        try {
          result = await inputAction({}, formData);
        } catch (err) {
          rethrowNextErrors(err);
          result = { type: 'error', reason: tChat('intent_error') };
        }

        // URL + state sync on first response that brings back conversationId
        if (
          typeof result.conversationId === 'number' &&
          result.conversationId !== currentConversationId
        ) {
          setCurrentConversationId(result.conversationId);
          router.replace(`/?c=${result.conversationId}`);
        }

        if (result.type === 'wait') {
          const bufferedMessageId = result.bufferedMessageId;
          const bufferedExpiresAt = result.bufferedExpiresAt;
          if (typeof bufferedMessageId === 'number' && typeof bufferedExpiresAt === 'number') {
            setMessages((prev) =>
              prev.flatMap((m) => {
                if (m.id === pendingMsg.id) return [];
                if (m.id !== userMsg.id) return [m];
                return [
                  {
                    ...m,
                    id: `db-${bufferedMessageId}`,
                    dbMessageId: bufferedMessageId,
                    status: 'buffered_wait',
                    bufferedExpiresAt,
                    metadata: {
                      ...(m.metadata ?? {}),
                      waitReasonKey: result.waitReasonKey ?? 'awaiting_clarification',
                    },
                  },
                ];
              }),
            );
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === pendingMsg.id
                  ? {
                      ...m,
                      pending: false,
                      content: tChat('intent_error'),
                      resultType: 'error',
                    }
                  : m,
              ),
            );
          }
          setScrollTrigger((prev) => prev + 1);
          return result;
        }

        // Build final assistant message to replace the pending bubble
        const assistantMsg: ChatMessage = {
          id: pendingMsg.id,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          resultType: result.type,
        };

        switch (result.type) {
          case 'query':
            assistantMsg.content = result.answer ?? tChat('no_answer');
            assistantMsg.queryResult = {
              answer: result.answer ?? '',
              confidence: result.confidence ?? 'no_data',
              citedEntities: result.citedEntities ?? [],
            };
            break;
          case 'submit':
            assistantMsg.submitResult = {
              status: result.status ?? 'rejected',
              taskId: result.taskId,
              reason: result.reason,
              warnings: result.warnings,
              ...(result.inputMode !== undefined && { inputMode: result.inputMode }),
              ...(result.status === 'duplicate' && {
                existingTaskId: result.existingTaskId ?? null,
                existingSourceId: result.existingSourceId,
                existingUrl: result.existingUrl,
              }),
            };
            assistantMsg.content =
              result.status === 'accepted'
                ? tChat('submit_accepted', { taskId: result.taskId ?? '' })
                : result.status === 'duplicate'
                  ? tChat('submit_duplicate')
                  : (result.reason ?? tChat('submit_rejected'));
            if (result.status === 'accepted') {
              router.refresh();
            }
            break;
          case 'content':
            assistantMsg.content = result.contentText ?? '';
            assistantMsg.contentResult = {
              text: result.contentText ?? '',
              format: result.contentFormat,
              title: result.contentTitle,
            };
            break;
          case 'action':
            assistantMsg.content = result.actionMessage ?? '';
            assistantMsg.actionResult = {
              message: result.actionMessage ?? '',
              actionId: result.actionId,
            };
            break;
          case 'clarify':
            assistantMsg.content = result.clarifyQuestion ?? '';
            assistantMsg.clarifyResult = {
              question: result.clarifyQuestion ?? '',
              options: result.clarifyOptions,
              ...(result.clarifyQuestionKey !== undefined && {
                questionKey: result.clarifyQuestionKey,
              }),
              ...(result.clarifyStructuredOptions !== undefined && {
                structuredOptions: result.clarifyStructuredOptions,
              }),
            };
            // P5: pre-bind originalUserContent on clarify too, mirroring the
            // reload path (convertConversationMessagesToChat does the same).
            assistantMsg.originalUserContent = userMsg.content;
            break;
          case 'note':
            // P5: un-squashed (P4 squashed into 'action'). ReclassifyChipBar
            // needs noteId + subtype + originalUserContent to dispatch
            // forcedIntent when user picks a different intent. `userMsg.content`
            // is the trimmed user input from the start of this handler.
            // P5 Fix Batch 6 (M2/M3): server contract guarantees both noteId
            // and noteSubtype are present on a successful note result. If
            // either is missing it's a server bug — no `noteId ?? 0` sentinel
            // that quietly papers over the bug, no `?? 'note'` subtype
            // fallback that mislabels the chip.
            // PR #57 F-CASE-NOTE-EMPTY-BUBBLE: falls through to setMessages
            // below; assistantMsg flipped to 'error' so the user sees a
            // meaningful bubble instead of a blank span. console.error above
            // stays for diagnostics.
            if (result.noteId === undefined || result.noteSubtype === undefined) {
              console.error('[chat-view] note result missing noteId or noteSubtype', result);
              assistantMsg.content = tChat('intent_error');
              assistantMsg.resultType = 'error';
              break;
            }
            assistantMsg.content = tChat('note_saved_inline', { noteId: result.noteId });
            assistantMsg.noteResult = {
              noteId: result.noteId,
              subtype: result.noteSubtype,
            };
            assistantMsg.originalUserContent = userMsg.content;
            break;
          case 'error':
          case undefined:
            assistantMsg.content = result.reason ?? tChat('intent_error');
            break;
          default: {
            const _exhaustive: never = result.type;
            console.warn('[ChatView] Unhandled result type:', _exhaustive);
            assistantMsg.content = result.reason ?? tChat('intent_error');
          }
        }

        // Replace pending bubble with final message (also removes pending flag)
        setMessages((prev) => prev.map((m) => (m.id === pendingMsg.id ? assistantMsg : m)));
        setScrollTrigger((prev) => prev + 1);

        return result;
      } finally {
        actionInFlightRef.current = false;
      }
    },
    {},
  );

  // P4: clarify chip 点击两路分发：
  //   1) resolve_tracking_entity → 直接调 web-sdk 的 /tracking/rules/:id/resolve
  //      (CAS by status='awaiting_clarify')，不走 LLM classifier；router.refresh()
  //      让 server component 重拉 conversation 并刷新追踪卡。
  //   2) 其它 intentKey → 走 forcedIntent /input 路径让 server 跳过 classifier
  //      直接 dispatch 到对应 plugin。FormData 字段集合与普通 ChatInput 提交
  //      保持一致，让 useActionState 跟踪 isPending 阻塞二次点击。
  const handleClarifyChipClick = useCallback(
    async (intentKey: string, payload?: string, originalUserContent?: string) => {
      if (intentKey === 'resolve_tracking_entity') {
        if (!payload) return;
        // PR #57 F-CLARIFY-PARSE-BANNER: split JSON parse from the SDK call.
        // The original combined try/catch surfaced both "bad chip metadata"
        // and "server rejected resolve" as the same generic intent_error
        // banner — opaque for the user (refresh fixes one but not the other).
        // Parse first with a dedicated message; the SDK call falls through
        // to the existing generic handler.
        let parsed: { trackingRuleId: number; entityId: number };
        try {
          parsed = JSON.parse(payload) as { trackingRuleId: number; entityId: number };
        } catch (parseErr) {
          console.error('clarify payload parse failed', parseErr);
          setErrorBanner(tChat('clarify_parse_error'));
          return;
        }
        try {
          await getBrowserApiClient().resolveTrackingClarify(
            parsed.trackingRuleId,
            parsed.entityId,
          );
          router.refresh();
        } catch (err) {
          console.error('resolve tracking clarify failed', err);
          setErrorBanner(tChat('intent_error'));
        }
        return;
      }
      if (!originalUserContent) return;
      const formData = new FormData();
      formData.append('input', originalUserContent);
      formData.append('forcedIntent', intentKey);
      if (payload) formData.append('payload', payload);
      formData.append('sessionKey', WEB_SESSION_KEY);
      formData.append('maxInputLength', String(maxInputLength));
      if (currentConversationId !== null) {
        formData.append('conversationId', String(currentConversationId));
      }
      startTransition(() => {
        void action(formData);
      });
    },
    [router, action, maxInputLength, currentConversationId, tChat],
  );

  // P5 Task 10: ReclassifyChipBar 点击 → useReclassifyNote hook 内部完成
  // (1) updateNote(archived=true) 原 note 软删
  // (2) /input forcedIntent 用 originalContent 重新分发到目标 plugin
  // (3) 失败时 rollback unarchive 原 note，避免内容失踪
  // chat-view 只负责把回调结果落地到 UI：成功后 router.refresh() 让 server
  // component 重拉 conversation —— archived note bubble 会消失、新 result
  // 以正确 plugin 的形式入列；失败 banner 化以保留 ChipBar 让用户重试。
  const { reclassify, isReclassifying } = useReclassifyNote({
    onSuccess: ({ noteId, dispatchedResult, fellBackToSession }) => {
      // P5 Fix Batch 5 (I3): 记下"已 reclassify 过的 noteId" — refresh 之后
      // server 仍会通过 metadata 把该 noteId 还原成 note bubble，但渲染时会
      // 被 MessageBubble 拦截改显"已重新分类"提示，避免重复点击纠错。
      setReclassifiedNoteIds((prev) => {
        const next = new Set(prev);
        next.add(noteId);
        return next;
      });
      // PR #57 F-CHAT-FALLBACK-NAV-MISSING: when the dispatch retry fired
      // because the caller-provided conversation was archived, the new
      // assistant turn landed in a *different* conversation. router.refresh()
      // would re-render the current archived view — user wouldn't see their
      // dispatch. Surface an info banner + navigate to the new conversation
      // so the user follows the flow.
      const dispatchedConvId = (dispatchedResult as { conversationId?: number }).conversationId;
      if (
        fellBackToSession &&
        dispatchedConvId !== undefined &&
        dispatchedConvId !== currentConversationId
      ) {
        setInfoBanner(tChat('reclassify_fallback_session'));
        router.push(`/?c=${dispatchedConvId}&reclassifyFallback=1`);
      } else if (fellBackToSession) {
        setInfoBanner(tChat('reclassify_fallback_session'));
        router.refresh();
      } else if (dispatchedConvId !== undefined && dispatchedConvId !== currentConversationId) {
        router.push(`/?c=${dispatchedConvId}`);
      } else {
        router.refresh();
      }
    },
    onError: (err) => setErrorBanner(err.message),
    // PR #57 F-CHAT-NO-ROLLBACK-FAILED: when dispatch fails AND rollback
    // unarchive also fails, the original note stays archived + invisible.
    // A generic dispatch error banner doesn't tell the user where to look.
    // Surface the rollback-aware message pointing at the archived list.
    onRollbackFailed: (_rollbackErr, originalErr) =>
      setErrorBanner(tChat('reclassify_rollback_failed', { error: originalErr.message })),
  });

  const handleReclassifyClick = useCallback(
    (p: { noteId: number; originalContent: string; targetIntentKey: string }) => {
      void reclassify({
        ...p,
        ...(currentConversationId !== null && { conversationId: currentConversationId }),
        sessionKey: WEB_SESSION_KEY,
      });
    },
    [reclassify, currentConversationId],
  );

  // Auto-scroll to bottom when messages are added or replaced
  useEffect(() => {
    if (scrollTrigger > 0) {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      messagesEndRef.current?.scrollIntoView({
        behavior: prefersReducedMotion ? 'instant' : 'smooth',
      });
    }
  }, [scrollTrigger]);

  const hasConversation = messages.length > 0 || currentConversationId !== null;

  return (
    <>
      <div className="gp-chat">
        {errorBanner && (
          <div className="gp-chat__error-banner" role="alert">
            <span className="gp-chat__error-banner-text">{errorBanner}</span>
            <button
              type="button"
              className="gp-chat__error-banner-close"
              onClick={() => setErrorBanner(null)}
              aria-label={tChat('error_banner_close')}
            >
              ×
            </button>
          </div>
        )}
        {infoBanner && (
          <div className="gp-chat__info-banner" role="status">
            <span className="gp-chat__info-banner-text">{infoBanner}</span>
            <button
              type="button"
              className="gp-chat__info-banner-close"
              onClick={() => setInfoBanner(null)}
              aria-label={tChat('error_banner_close')}
            >
              ×
            </button>
          </div>
        )}
        {hasConversation && (
          <ChatHeader
            onNewConversation={handleNewConversation}
            disabled={isPending || isUnarchiving || isCreatingNew || isReclassifying}
            messageCount={userMessageCount}
          />
        )}
        {messages.length === 0 ? (
          <div className="gp-chat__default">
            <ChatDefault
              recentConversations={recentConversations}
              onRecentClick={handleRecentClick}
              recentDisabled={isUnarchiving || isReclassifying}
            />
            {recentConversationsFailed && (
              <p className="gp-chat__recent-load-failed" role="status">
                {tChat('recent_load_failed')}
              </p>
            )}
          </div>
        ) : (
          <div className="gp-chat__messages">
            <ErrorBoundary
              resetKey={messages.length}
              fallback={<p className="gp-chat__error">{tChat('render_error')}</p>}
            >
              <MessageList
                messages={messages}
                onEntitySelect={(entity) => setInspectorPayload({ kind: 'entity', id: entity.id })}
                onReleaseBuffered={handleReleaseBuffered}
                onCancelBuffered={handleCancelBuffered}
                onClarifyChipClick={handleClarifyChipClick}
                onReclassify={handleReclassifyClick}
                reclassifyDisabled={isReclassifying}
                reclassifiedNoteIds={reclassifiedNoteIds}
              />
            </ErrorBoundary>
            <div ref={messagesEndRef} />
          </div>
        )}
        <div className="gp-chat__input-area">
          <ChatInput
            action={action}
            isPending={isPending || isUnarchiving || isReclassifying}
            maxInputLength={maxInputLength}
            value={inputValue}
            onChange={setInputValue}
            textareaRef={textareaRef}
          />
        </div>
      </div>
      <Inspector
        payload={inspectorPayload}
        onClose={() => setInspectorPayload(null)}
        backFallbackLabel={tInspector('back_fallback')}
        closeLabel={tInspector('close')}
        getKindLabel={(kind) => tInspector(`kind_${kind}`)}
      />
    </>
  );
}
