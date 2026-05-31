'use client';

import {
  GoldpanApiError,
  type InputResult,
  NOTE_SUBTYPES,
  type NoteDetail,
  PROMOTE_NOTE_MIN_CONTENT_LENGTH,
  type UpdateNoteInput,
} from '@goldpan/web-sdk';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfirm } from '@/components/confirm-provider';
import { useTz } from '@/components/tz-provider';
import { useFetchOnIdChange } from '@/hooks/use-fetch-on-id-change';
import { useReclassifyNote } from '@/hooks/use-reclassify-note';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import {
  formatDateMinute,
  formatDateOnly,
  formatLocalDateTimeInput,
  parseLocalDateTimeInput,
} from '@/lib/format';
import { parseEntityMentions } from '@/lib/parse-entity-mentions';
import { WEB_SESSION_KEY } from '@/lib/session';
import { StateError } from '../../state/state-error';
import { StateLoading } from '../../state/state-loading';
import { MentionAwareContent } from './mention-aware-content';
import type { InspectorPayload, PayloadAction, PayloadCapabilitySet } from './types';

// PR #57 F-SUBTYPES-DUPL: use the single source of truth from web-sdk so the
// chip row order + i18n fan-out can't drift from the wire type. Adding a
// subtype in web-sdk without updating `notes_subtype_*` keys still trips the
// typecheck assertion at the bottom of the i18n schema.
const SUBTYPES = NOTE_SUBTYPES;

const fetchNote = (id: number, signal: AbortSignal) => getBrowserApiClient().getNote(id, signal);
type LibraryTranslator = ReturnType<typeof useTranslations<'library'>>;

function formatLinkedSourceLabel(
  source: NoteDetail['linkedSources'][number],
  tLib: LibraryTranslator,
): string {
  if (source.title?.trim()) return source.title.trim();
  if (source.originalUrl) return source.originalUrl;
  const preview = source.rawContentPreview?.trim();
  if (preview) return tLib('source_preview_quoted', { snippet: preview });
  return `#${source.id}`;
}

/**
 * P5 Fix Batch 3 (C4): translate wire-shape patch → detail-shape so the
 * optimistic snapshot renders correctly. `UpdateNoteInput` carries
 * `linkedEntityIds: number[]` but the render path reads `linkedEntities:
 * {id, name}[]` — a bare `{...detail, ...patch}` left chips visible until
 * the PATCH round-trip resolved.
 *
 * Pure / module-scope so React doesn't re-create it per render.
 *
 * We do NOT add entities here (entity picker is P7) — picker would have to
 * provide a full `{id, name}` shape via a separate flow. Removed entities
 * drop out via `filter`, keeping the previous `name` for survivors.
 */
function applyPatchToDetail(detail: NoteDetail, patch: UpdateNoteInput): NoteDetail {
  const next: NoteDetail = { ...detail };
  if (patch.content !== undefined) next.content = patch.content;
  if (patch.subtype !== undefined) next.subtype = patch.subtype;
  if (patch.tags !== undefined) next.tags = patch.tags;
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.archived !== undefined) next.archived = patch.archived;
  if (patch.linkedEntityIds !== undefined) {
    const allowed = new Set(patch.linkedEntityIds);
    next.linkedEntities = detail.linkedEntities.filter((e) => allowed.has(e.id));
  }
  // `dueAt === null` is a legal value (用户清空 due-date)，必须用 !== undefined。
  if (patch.dueAt !== undefined) {
    next.dueAt = patch.dueAt;
    if (patch.dueAt === null || (next.remindedAt !== null && patch.dueAt > next.remindedAt)) {
      next.remindedAt = null;
    }
  }
  return next;
}

interface NotePayloadProps {
  id: number;
  onTitleReady: (title: string) => void;
  onNavigateEntity: (next: InspectorPayload) => void;
  onAction?: (action: PayloadAction) => Promise<void>;
  capabilities?: PayloadCapabilitySet;
  /**
   * P5 (一轮 review): delete / reclassify 成功后调用让 shell 关闭 inspector
   * —— 用户视角：删了 / 重新分类后还显示已删 note 是 404 体验。
   */
  onClose?: () => void;
  /**
   * P5 Fix Batch 3 (I6): report content-dirty so Inspector shell can run
   * the same close-confirmation it does for InterestPayload. Only `content`
   * counts as dirty here — subtype / tags / pinned / archived are immediate
   * PATCHes that resolve before the user can close.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

export function NotePayload({
  id,
  onTitleReady,
  onNavigateEntity,
  onAction: _onAction,
  capabilities: _capabilities,
  onClose,
  onDirtyChange,
}: NotePayloadProps) {
  const t = useTranslations('note_payload');
  const tLib = useTranslations('library');
  const tCommon = useTranslations('common');
  const tz = useTz();
  const router = useRouter();
  const confirm = useConfirm();

  const [override, setOverride] = useState<NoteDetail | null>(null);
  // §1 一轮 review: 只 content 走 dirty 桶 — subtype / tags / linkedEntityIds /
  // pinned / archived 全部即时 PATCH。
  const [dirtyContent, setDirtyContent] = useState<string | null>(null);
  // PR #57 F-TEXTAREA-OVER-DISABLE: split "content Save in flight" from the
  // universal "any PATCH in flight" flag. textarea + Save/Cancel buttons only
  // disable on contentSaveInFlight (so pin/archive/tag PATCHes don't freeze
  // the editor); immediate-PATCH controls (chip / pin / archive / tag remove
  // / entity remove / tag input) still gate on savingPatch.
  const [savingPatch, setSavingPatch] = useState(false);
  const [contentSaveInFlight, setContentSaveInFlight] = useState(false);
  const patchInFlightRef = useRef(false);
  // PR #57 F-PATCH-RECONCILE-RACE: per-request token. An in-flight PATCH
  // whose response arrives after id-change (Inspector push) was stale-setting
  // override → user saw the previous note's data on the new note. Bump on
  // entry, capture local, compare in resolve/reject, skip state writes if the
  // token has moved on. Reset in `onReady` so a fresh fetch clears the
  // sentinel without leaking across notes.
  const patchRequestIdRef = useRef(0);
  const currentIdRef = useRef(id);
  currentIdRef.current = id;
  const [reclassifyModalOpen, setReclassifyModalOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [tagInputValue, setTagInputValue] = useState('');
  // P7.1 Task 4: promote-to-source pending + error state. promoteError renders
  // inline below the button (not in the top errorBanner) so it sits next to
  // the action that produced it; promotePending disables the button + shows
  // the loading glyph.
  const [promotePending, setPromotePending] = useState(false);
  const [promoteError, setPromoteError] = useState<Error | null>(null);
  // P7.2: translate-this-note button state. translatePending disables the
  // button + shows spinner glyph; translateError surfaces inline below the
  // button without polluting the top errorBanner (mirror promote pattern).
  const [translatePending, setTranslatePending] = useState(false);
  const [translateError, setTranslateError] = useState<Error | null>(null);
  const translateRequestIdRef = useRef(0);
  // P7.3: mention parsing state. knownEntities maps lowercased name → entity
  // id, populated by an effect that diff-fetches against content +
  // contentTranslated. Effect aborts on detail change to prevent stale writes.
  const [knownEntities, setKnownEntities] = useState<Map<string, number>>(new Map());

  const { state, retry } = useFetchOnIdChange(id, fetchNote, {
    onReady: (d) => {
      onTitleReady(t('inspector_title', { id: d.id }));
      setOverride(null);
      setDirtyContent(null);
      // Reset the request-token sentinel — any pre-id-change in-flight PATCH
      // resolution will compare against a token that has moved on and skip
      // writing stale state.
      patchRequestIdRef.current += 1;
    },
  });

  const detail = override ?? (state.status === 'ready' ? state.data : null);

  useEffect(() => {
    currentIdRef.current = id;
    translateRequestIdRef.current += 1;
    setTranslatePending(false);
    setTranslateError(null);
  }, [id]);

  const applyImmediatePatch = useCallback(
    async (patch: UpdateNoteInput) => {
      if (!detail) return;
      // P5 Fix Batch 3 (M5): drop concurrent immediate-PATCH clicks. Without
      // this, two rapid clicks (e.g. pin then subtype) issue two PATCHes and
      // a later response can clobber state set by the click in between.
      // Ref instead of state so the guard is consistent within the same tick.
      if (patchInFlightRef.current) return;
      // Snapshot the pre-patch detail so a rejected request can roll the
      // optimistic update back without re-issuing the GET. We keep the
      // snapshot in a local because `detail` itself flips synchronously
      // when setOverride fires below.
      const snapshot = detail;
      // P5 Fix Batch 3 (C4): translate wire-shape patch → detail-shape so
      // chip removals reflect immediately. Plain `{...detail, ...patch}` left
      // `linkedEntityIds: number[]` floating without updating the rendered
      // `linkedEntities: {id, name}[]` array.
      setOverride(applyPatchToDetail(snapshot, patch));
      setErrorBanner(null);
      patchInFlightRef.current = true;
      setSavingPatch(true);
      // PR #57 F-PATCH-RECONCILE-RACE: capture this request's token. When the
      // response arrives, compare against the current ref — if id-change
      // (Inspector push) bumped the token in between, skip state writes so
      // the previous note's data doesn't clobber the new note's render.
      patchRequestIdRef.current += 1;
      const requestId = patchRequestIdRef.current;
      try {
        const updated = await getBrowserApiClient().updateNote(id, patch);
        if (patchRequestIdRef.current !== requestId) return;
        setOverride(updated);
        // PR #57 F-NON-ARCHIVE-STALE: NotesSection SSR shows latest snapshot
        // for ALL fields (subtype color, pin badge, tag list, entity links —
        // not just archived state). Every successful PATCH refreshes the
        // route so the left-side list reflects the same edit the inspector
        // just made. archived=true *also* closes the inspector (un-archive
        // is a list-level recovery flow).
        router.refresh();
        if (patch.archived === true) onClose?.();
      } catch (err) {
        console.error('[NotePayload] immediate patch failed', err);
        if (patchRequestIdRef.current !== requestId) return;
        setOverride(snapshot);
        setErrorBanner(t('update_failed'));
      } finally {
        patchInFlightRef.current = false;
        setSavingPatch(false);
      }
    },
    [detail, id, onClose, router, t],
  );

  // PR #57 F-ARCHIVE-DELETE-BYPASS-DIRTY: keep the dirty-block logic local to
  // a single helper so toggleArchive / handleDelete share the exact same
  // gate + banner. The Inspector central dirty-guard now wraps onClose, but
  // intercepting the destructive button *here* gives the user an immediate
  // "save first" hint instead of a post-fact confirm dialog after a mutation
  // already ran.
  const isDirty = dirtyContent !== null;
  const blockIfDirty = useCallback(
    (
      messageKey: 'action_blocked_dirty' | 'navigation_blocked_dirty' = 'action_blocked_dirty',
    ): boolean => {
      if (isDirty || savingPatch) {
        setErrorBanner(t(messageKey));
        return true;
      }
      return false;
    },
    [isDirty, savingPatch, t],
  );

  const togglePin = useCallback(() => {
    if (!detail) return;
    void applyImmediatePatch({ pinned: !detail.pinned });
  }, [detail, applyImmediatePatch]);

  const toggleArchive = useCallback(() => {
    if (!detail) return;
    if (blockIfDirty()) return;
    void applyImmediatePatch({ archived: !detail.archived });
  }, [detail, applyImmediatePatch, blockIfDirty]);

  const handleSave = useCallback(async () => {
    if (!detail || dirtyContent === null) return;
    // P5 Fix Batch 3 (M5): same in-flight gate as applyImmediatePatch so an
    // already-running PATCH can't race a Save click. ref guard mirrors the
    // immediate path; savingPatch state stays the public disable flag.
    if (patchInFlightRef.current) return;
    patchInFlightRef.current = true;
    setSavingPatch(true);
    // PR #57 F-TEXTAREA-OVER-DISABLE: contentSaveInFlight is the textarea /
    // Save / Cancel gate — savingPatch keeps gating immediate-PATCH controls
    // so the user can't fire pin/archive while Save is mid-flight.
    setContentSaveInFlight(true);
    setErrorBanner(null);
    // PR #57 F-PATCH-RECONCILE-RACE: same per-request token gate as
    // applyImmediatePatch — id-change mid-flight must skip the state writes.
    patchRequestIdRef.current += 1;
    const requestId = patchRequestIdRef.current;
    try {
      const updated = await getBrowserApiClient().updateNote(id, { content: dirtyContent });
      if (patchRequestIdRef.current !== requestId) return;
      setOverride(updated);
      setDirtyContent(null);
      router.refresh();
    } catch (err) {
      console.error('[NotePayload] save failed', err);
      if (patchRequestIdRef.current !== requestId) return;
      // PR #57 F-SAVE-NO-DRAFT-HINT: the generic update_failed banner doesn't
      // tell the user their local edits are still in the textarea — many
      // users will refresh / leave because they assume the draft was wiped.
      // Use a save-specific copy that explicitly says the draft is preserved.
      setErrorBanner(t('save_failed_draft_preserved'));
    } finally {
      patchInFlightRef.current = false;
      setSavingPatch(false);
      setContentSaveInFlight(false);
    }
  }, [detail, id, dirtyContent, router, t]);

  const removeTag = useCallback(
    (tag: string) => {
      if (!detail) return;
      void applyImmediatePatch({ tags: detail.tags.filter((x) => x !== tag) });
    },
    [detail, applyImmediatePatch],
  );

  const submitTagInput = useCallback(() => {
    const trimmed = tagInputValue.trim().toLowerCase();
    if (!detail || !trimmed || detail.tags.includes(trimmed)) {
      setTagInputValue('');
      return;
    }
    void applyImmediatePatch({ tags: [...detail.tags, trimmed] });
    setTagInputValue('');
  }, [detail, tagInputValue, applyImmediatePatch]);

  const removeLinkedEntity = useCallback(
    (entityId: number) => {
      if (!detail) return;
      void applyImmediatePatch({
        linkedEntityIds: detail.linkedEntities.filter((x) => x.id !== entityId).map((x) => x.id),
      });
    },
    [detail, applyImmediatePatch],
  );

  const handleDelete = useCallback(async () => {
    if (!detail) return;
    // PR #57 F-ARCHIVE-DELETE-BYPASS-DIRTY: block before showing the confirm
    // dialog — otherwise a user with unsaved edits would confirm delete,
    // delete fires, then central Inspector dirty guard pops a *second*
    // confirm; cancelling the second leaves the inspector open showing a
    // note that no longer exists on the server.
    if (blockIfDirty()) return;
    const ok = await confirm({
      message: t('delete_confirm'),
      confirmLabel: tCommon('delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await getBrowserApiClient().deleteNote(id);
      // 一轮 review: 关闭 inspector + refresh router 让 NotesSection 重拉。
      onClose?.();
      router.refresh();
    } catch (err) {
      console.error('[NotePayload] delete failed', err);
      setErrorBanner(t('delete_failed'));
    }
  }, [blockIfDirty, confirm, detail, id, onClose, router, t, tCommon]);

  // P7.1 Task 4: promote this note to a brand-new source — kicks off a full
  // pipeline run. On success, close the inspector + push to `/tasks/${taskId}`
  // (plural + bracketed segment — verified `apps/web/src/app/tasks/[taskId]`)
  // so the user immediately sees the new task progress instead of staying on
  // the now-linked note.
  const handlePromote = useCallback(async () => {
    if (!detail) return;
    if (blockIfDirty()) return;
    const trimmedContent = detail.content.trim();
    if (
      detail.archived ||
      !trimmedContent ||
      trimmedContent.length < PROMOTE_NOTE_MIN_CONTENT_LENGTH
    ) {
      return;
    }
    const confirmed = await confirm({
      message: t('promote_confirm_message'),
      confirmLabel: t('promote_confirm_label'),
    });
    if (!confirmed) return;
    setPromotePending(true);
    setPromoteError(null);
    try {
      const { taskId } = await getBrowserApiClient().promoteNote(detail.id);
      onClose?.();
      router.push(`/tasks/${taskId}`);
    } catch (err) {
      setPromoteError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setPromotePending(false);
    }
  }, [blockIfDirty, confirm, detail, onClose, router, t]);

  const locale = useLocale();

  // P7.2: trigger LLM translation of note.content into the current UI locale.
  // Manual trigger overrides the GOLDPAN_TRANSLATE_PIPELINE_OUTPUT env gate
  // (clicking the button IS explicit consent). Server still rejects when
  // note.language === config.language with already_target_language; UI hides
  // the button in that case as a first-line UX guard.
  const handleTranslate = useCallback(async () => {
    if (!detail) return;
    if (blockIfDirty()) return;
    if (!detail.content.trim()) return;
    translateRequestIdRef.current += 1;
    const requestId = translateRequestIdRef.current;
    const noteId = detail.id;
    setTranslatePending(true);
    setTranslateError(null);
    try {
      const { contentTranslated } = await getBrowserApiClient().translateNote(noteId);
      if (translateRequestIdRef.current !== requestId || currentIdRef.current !== noteId) return;
      setOverride((prev) => {
        const base = prev ?? detail;
        return { ...base, contentTranslated };
      });
    } catch (err) {
      if (translateRequestIdRef.current !== requestId || currentIdRef.current !== noteId) return;
      setTranslateError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (translateRequestIdRef.current === requestId && currentIdRef.current === noteId) {
        setTranslatePending(false);
      }
    }
  }, [blockIfDirty, detail]);

  // due-date 设定的副作用：null → 非 null 的过渡 = 用户第一次给这条 note
  // 加提醒，借这个 gesture 同步请求 Notification 权限。LibraryShell mount
  // 时主动弹权限会被绝大多数浏览器视为骚扰；只在用户真有提醒需求时才请求
  // 才符合 self-host 单用户 / 小团队的体感。`requestPermission` 必须保持
  // 同步调用（不能 await），否则 Safari 会因失去 user-gesture 拒绝弹窗。
  const handleDueAtChange = useCallback(
    (rawValue: string) => {
      if (!detail) return;
      const parsed = parseLocalDateTimeInput(rawValue, tz);
      const wasNull = detail.dueAt === null;
      let showDeniedWarning = false;
      if (wasNull && parsed !== null && typeof window !== 'undefined' && 'Notification' in window) {
        if (window.Notification.permission === 'denied') {
          showDeniedWarning = true;
        } else if (window.Notification.permission === 'default') {
          try {
            window.Notification.requestPermission()
              .then((result) => {
                if (result === 'denied') {
                  setErrorBanner(t('notification_denied_banner_only'));
                }
              })
              .catch(() => {
                // banner-only fallback — Promise reject 时静默，UI 仍会通过页面内
                // banner 兜底提醒，不阻塞 PATCH。
              });
          } catch {
            // 老浏览器 requestPermission 同步抛 — banner-only fallback。
          }
        }
      }
      void applyImmediatePatch({ dueAt: parsed });
      if (showDeniedWarning) {
        setErrorBanner(t('notification_denied_banner_only'));
      }
    },
    [applyImmediatePatch, detail, t, tz],
  );

  const handleSourceMessageClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (blockIfDirty('navigation_blocked_dirty')) {
        event.preventDefault();
      }
    },
    [blockIfDirty],
  );

  const { reclassify, isReclassifying } = useReclassifyNote({
    // The payload closes itself and navigates to chat. If dispatch had to fall
    // back to the session conversation, carry a URL flag so the remounted
    // ChatView can show the one-shot "switched conversation" notice.
    onSuccess: ({
      dispatchedResult,
      fellBackToSession,
    }: {
      dispatchedResult: InputResult;
      fellBackToSession: boolean;
    }) => {
      // §4 一轮 review: hook 已 archive + dispatch；inspector caller 关 modal
      // + 关 inspector + 跳 chat 让用户立即看到新 result。
      setReclassifyModalOpen(false);
      onClose?.();
      const convId = (dispatchedResult as { conversationId?: number }).conversationId;
      if (convId !== undefined) {
        router.push(fellBackToSession ? `/?c=${convId}&reclassifyFallback=1` : `/?c=${convId}`);
      } else {
        router.push(fellBackToSession ? '/?reclassifyFallback=1' : '/');
      }
    },
    onError: (err) => {
      setReclassifyModalOpen(false);
      setErrorBanner(err.message);
    },
    // P5 Fix Batch 3 (I9): rollback failure path — the default onError text
    // is dispatch's error, which doesn't tell the user the original note is
    // now archived + missing from /library default view. This dedicated key
    // points them to the archived list to recover. Fires BEFORE onError so
    // it wins the setErrorBanner call.
    onRollbackFailed: (_rollbackErr, originalErr) => {
      setReclassifyModalOpen(false);
      setErrorBanner(t('reclassify_rollback_failed', { error: originalErr.message }));
    },
  });

  // P5 Fix Batch 3 (I6): report content-dirty to the Inspector shell, mirroring
  // InterestPayload. Cleanup clears the flag so closing the inspector while
  // dirty doesn't strand the parent's confirm guard.
  // (`isDirty` is declared above next to blockIfDirty so the shared dirty
  // gate can use it without forward references.)
  useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  // P7.3: lookup entities for mentions in content + translation. Runs when
  // detail's text fields change. AbortController prevents writing stale
  // results after the user opens a different note or content changes again.
  // Narrowed to `detail?.content` + `detail?.contentTranslated` on purpose:
  // every PATCH response replaces the `detail` reference (setOverride), so
  // depending on full `detail` would refetch entity lookups on every pin /
  // archive / tag PATCH even when the text didn't change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional narrow deps; see comment above.
  useEffect(() => {
    if (!detail) return;
    const allText = `${detail.content}\n${detail.contentTranslated ?? ''}`;
    const names = Array.from(
      new Set(parseEntityMentions(allText).map((m) => m.name.toLowerCase())),
    );
    if (names.length === 0) {
      setKnownEntities(new Map());
      return;
    }
    const controller = new AbortController();
    getBrowserApiClient()
      .lookupEntitiesByName(names, controller.signal)
      .then((map) => {
        if (controller.signal.aborted) return;
        setKnownEntities(new Map(Object.entries(map)));
      })
      .catch(() => {
        // Silent — mentions will fall through to unresolved style.
      });
    return () => controller.abort();
  }, [detail?.content, detail?.contentTranslated]);

  // P7.3: chips for mentions resolved to entities that are NOT already in
  // detail.linkedEntities (avoid duplicate visual entry). Sorted by first
  // appearance order in (content + translation) for predictability. Must be
  // declared above the early returns so hook order stays stable.
  const mentionedChips = useMemo(() => {
    if (!detail) return [];
    const linkedIds = new Set(detail.linkedEntities.map((e) => e.id));
    const allText = `${detail.content}\n${detail.contentTranslated ?? ''}`;
    const occurrences = parseEntityMentions(allText);
    const seen = new Set<number>();
    const out: Array<{ id: number; name: string }> = [];
    for (const m of occurrences) {
      const id = knownEntities.get(m.name.toLowerCase());
      if (id === undefined || linkedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: m.name });
    }
    return out;
  }, [detail, knownEntities]);

  if (state.status === 'error') return <StateError error={state.error} onRetry={retry} />;
  if (!detail) return <StateLoading />;

  const currentContent = dirtyContent ?? detail.content;
  const savedContentLength = detail.content.trim().length;
  const promoteTooShort =
    savedContentLength > 0 && savedContentLength < PROMOTE_NOTE_MIN_CONTENT_LENGTH;
  const promoteTooShortMessage = t('promote_too_short', {
    min: PROMOTE_NOTE_MIN_CONTENT_LENGTH,
  });
  const promoteDisabled =
    detail.archived ||
    promotePending ||
    isDirty ||
    savingPatch ||
    !detail.content.trim() ||
    promoteTooShort;
  const promoteErrorMessage =
    promoteError instanceof GoldpanApiError && promoteError.code === 'note_too_short'
      ? promoteTooShortMessage
      : t('promote_failed');
  // P7.2: button visibility + disable + error-key derivation. Button hides
  // when note.language matches UI locale (server would reject with
  // `already_target_language`). disable mirrors promote (dirty / saving /
  // archived / empty). Error code → i18n key picked here so the JSX stays
  // declarative.
  const shouldShowTranslate = detail
    ? detail.language !== locale && detail.content.trim().length > 0
    : false;
  const translateDisabled =
    translatePending || isDirty || savingPatch || !!detail?.archived || !detail?.content.trim();
  const translateErrorCode = translateError instanceof GoldpanApiError ? translateError.code : null;
  const translateErrorMessage = translateError
    ? translateErrorCode === 'note_archived'
      ? t('translate_blocked_archived')
      : translateErrorCode === 'already_target_language'
        ? t('translate_already_target')
        : t('translate_failed')
    : null;
  const shouldShowTranslationPreview =
    !isDirty && !contentSaveInFlight && Boolean(detail.contentTranslated?.trim());

  return (
    <div className="gp-note-payload">
      {errorBanner && (
        <p role="alert" className="gp-note-payload__error">
          {errorBanner}
        </p>
      )}

      {/* Step 4: subtype chip row + pin/archive icons + createdAt */}
      <header className="gp-note-payload__head">
        <div className="gp-note-payload__subtype-row">
          {SUBTYPES.map((s) => (
            <button
              key={s}
              type="button"
              className={`gp-chip gp-note-subtype-chip gp-note-subtype-chip--${s}${
                detail.subtype === s ? ' is-active' : ''
              }`}
              // P5 Fix Batch 3 (M5): any in-flight write disables further
              // immediate PATCHes; active-subtype guard prevents redundant
              // no-op PATCH on click.
              disabled={savingPatch || detail.subtype === s}
              onClick={() => detail.subtype !== s && void applyImmediatePatch({ subtype: s })}
              aria-pressed={detail.subtype === s}
            >
              {tLib(`notes_subtype_${s}` as 'notes_subtype_memo' | 'notes_subtype_note')}
            </button>
          ))}
        </div>
        <div className="gp-note-payload__meta-icons">
          <button
            type="button"
            className={`gp-btn gp-note-payload__pin${detail.pinned ? ' is-active' : ''}`}
            data-variant="icon"
            data-size="sm"
            disabled={savingPatch}
            onClick={togglePin}
            aria-label={t(detail.pinned ? 'action_unpin' : 'action_pin')}
            title={t(detail.pinned ? 'action_unpin' : 'action_pin')}
          >
            ★
          </button>
          <button
            type="button"
            className={`gp-btn gp-note-payload__archive${detail.archived ? ' is-active' : ''}`}
            data-variant="icon"
            data-size="sm"
            // PR #57 F-ARCHIVE-DELETE-BYPASS-DIRTY: disable while content is
            // dirty so the user can't archive a draft they haven't saved.
            // The inline blockIfDirty() in toggleArchive is the second-line
            // defense — visually disabling here is the primary UX hint.
            disabled={savingPatch || isDirty}
            onClick={toggleArchive}
            aria-label={t(detail.archived ? 'action_unarchive' : 'action_archive')}
            title={t(detail.archived ? 'action_unarchive' : 'action_archive')}
          >
            📥
          </button>
        </div>
        <span className="gp-note-payload__date">{formatDateOnly(detail.createdAt, tz)}</span>
      </header>

      {/* Step 5a: content textarea + Save/Cancel buttons (gated on isDirty) */}
      <section className="gp-note-payload__content-section">
        <textarea
          className="gp-note-payload__content-textarea"
          value={currentContent}
          onChange={(e) =>
            setDirtyContent(e.target.value === detail.content ? null : e.target.value)
          }
          // PR #57 F-TEXTAREA-OVER-DISABLE: only freeze the textarea while a
          // *content* Save is in flight. Pin / archive / tag-edit immediate
          // PATCHes leave the user free to keep typing — earlier behaviour
          // (`disabled={savingPatch}`) froze the editor for any PATCH which
          // surprised users who pinned mid-edit. Save-in-flight still must
          // freeze: typing B after clicking Save with A would otherwise be
          // silently wiped by the response handler's `setDirtyContent(null)`.
          disabled={contentSaveInFlight}
          rows={6}
        />
        {isDirty && (
          <div className="gp-note-payload__save-row">
            <button
              type="button"
              className="gp-btn"
              data-variant="primary"
              disabled={contentSaveInFlight}
              onClick={handleSave}
            >
              {contentSaveInFlight ? t('action_save_pending') : t('action_save')}
            </button>
            <button
              type="button"
              className="gp-btn"
              data-variant="ghost"
              disabled={contentSaveInFlight}
              onClick={() => setDirtyContent(null)}
            >
              {tCommon('cancel')}
            </button>
          </div>
        )}
      </section>

      {/* P7.2: readonly translation preview for the saved note content. Hide
          while the textarea has an unsaved/saving draft so stale translations
          are not presented as translations of the current draft. */}
      {shouldShowTranslationPreview && (
        <section className="gp-note-payload__translation-preview" aria-live="polite">
          <h4 className="gp-note-payload__translation-preview-heading">
            {t('translation_preview_heading')}
          </h4>
          <p className="gp-note-payload__translation-preview-body">
            <MentionAwareContent
              content={detail.contentTranslated ?? ''}
              knownEntities={knownEntities}
              onNavigateEntity={onNavigateEntity}
              unresolvedTooltip={t('mention_unresolved_tooltip')}
            />
          </p>
        </section>
      )}

      {/* Step 5b: tags chip row + add input */}
      <section className="gp-note-payload__tags-section">
        <h4 className="gp-note-payload__section-title">{t('tags_heading')}</h4>
        <ul className="gp-chip-row">
          {detail.tags.map((tag) => (
            <li key={tag} className="gp-chip gp-note-payload__tag-chip">
              <span>{tag}</span>
              <button
                type="button"
                className="gp-note-payload__remove-tag"
                disabled={savingPatch}
                onClick={() => removeTag(tag)}
                aria-label={t('remove_tag_aria', { tag })}
              >
                ✕
              </button>
            </li>
          ))}
          <li>
            <input
              type="text"
              className="gp-note-payload__tag-input"
              placeholder={t('add_tag_placeholder')}
              value={tagInputValue}
              disabled={savingPatch}
              onChange={(e) => setTagInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitTagInput();
                }
              }}
              // PR #57 F-TAG-INPUT-BLUR-RACE: vanilla onBlur fires when focus
              // moves to a ✕ remove button inside the same tag section —
              // double-firing tag actions (e.g. submit "foo" then remove "t1"
              // because the input bled into the click). Gate on relatedTarget
              // so blur only commits when focus actually leaves the section.
              // (`relatedTarget` may be null if focus moves to nothing — in
              // that case we still want to submit, hence the `closest` check
              // only suppresses when the new focus is verifiably inside.)
              onBlur={(e) => {
                const next = e.relatedTarget;
                if (next instanceof Element && next.closest('.gp-note-payload__tags-section')) {
                  return;
                }
                submitTagInput();
              }}
            />
          </li>
        </ul>
      </section>

      {/* memo 子类专属 due-date 区段。`note` subtype 没有 "到点提醒" 的语义，
          也是 subtype 收敛到 memo/note 二分的核心原因。`isDirty` 时禁用避免
          用户在内容草稿未保存的同时改 dueAt 造成两个失败面。 */}
      {detail.subtype === 'memo' && (
        <section className="gp-note-payload__due-section">
          <label htmlFor="gp-note-payload__due-input" className="gp-note-payload__section-title">
            {t('due_at_label')}
          </label>
          <input
            id="gp-note-payload__due-input"
            type="datetime-local"
            className="gp-note-payload__due-input"
            value={formatLocalDateTimeInput(detail.dueAt, tz)}
            disabled={isDirty || savingPatch}
            onChange={(e) => handleDueAtChange(e.target.value)}
          />
          {detail.dueAt !== null && detail.remindedAt !== null && (
            <p className="gp-note-payload__due-status">
              {t('reminded_at', { time: formatDateMinute(detail.remindedAt, tz) })}
            </p>
          )}
        </section>
      )}

      {/* P7.3: mention chips — entities referenced via @name token that are
          NOT already in linkedEntities. Inline @ rendering inside textarea
          isn't possible; chip row is the equivalent UX surface. */}
      {mentionedChips.length > 0 && (
        <section className="gp-note-payload__mentioned">
          <h4 className="gp-note-payload__section-title">
            {t('mentioned_heading', { count: mentionedChips.length })}
          </h4>
          <ul className="gp-chip-row">
            {mentionedChips.map((ent) => (
              <li key={ent.id} className="gp-chip gp-note-payload__entity-chip">
                <button
                  type="button"
                  className="gp-note-payload__entity-link"
                  onClick={() => onNavigateEntity({ kind: 'entity', id: ent.id })}
                >
                  @{ent.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Step 6: linkedEntities chip row (一轮 review §2: no auto-badge) */}
      <section className="gp-note-payload__entities">
        <h4 className="gp-note-payload__section-title">
          {t('linked_entities_heading', { count: detail.linkedEntities.length })}
        </h4>
        <ul className="gp-chip-row">
          {detail.linkedEntities.map((ent) => (
            <li key={ent.id} className="gp-chip gp-note-payload__entity-chip">
              <button
                type="button"
                className="gp-note-payload__entity-link"
                onClick={() => onNavigateEntity({ kind: 'entity', id: ent.id })}
              >
                {ent.name}
              </button>
              <button
                type="button"
                className="gp-note-payload__remove-entity"
                disabled={savingPatch}
                onClick={() => removeLinkedEntity(ent.id)}
                aria-label={t('remove_entity_aria', { name: ent.name })}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Step 7a: linkedSources list (conditional) */}
      {detail.linkedSources.length > 0 && (
        <section className="gp-note-payload__sources">
          <h4 className="gp-note-payload__section-title">
            {t('linked_sources_heading', { count: detail.linkedSources.length })}
          </h4>
          <ul>
            {detail.linkedSources.map((s) => (
              <li key={s.id} className="gp-note-payload__source-item">
                <button
                  type="button"
                  className="gp-note-payload__source-link"
                  onClick={() => onNavigateEntity({ kind: 'source', id: s.id })}
                >
                  {formatLinkedSourceLabel(s, tLib)}
                </button>
                <span className="gp-note-payload__source-relation">
                  {t(
                    `source_relation_${s.relation}` as
                      | 'source_relation_reference'
                      | 'source_relation_derived_from',
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Step 7b: sourceMessage hyperlink (conditional) */}
      {detail.sourceMessageId !== null && detail.conversationId !== null && (
        <p className="gp-note-payload__source-msg">
          {t('source_message_label')}{' '}
          {/* anchor scroll deferred to P7 — chat 消息当前无 id=msg-X 元素，
              hash 形式留空待后续支持。 */}
          <Link
            href={`/?c=${detail.conversationId}`}
            onClick={handleSourceMessageClick}
            aria-disabled={isDirty || savingPatch ? true : undefined}
            title={isDirty || savingPatch ? t('navigation_blocked_dirty') : undefined}
          >
            {t('source_message_link', { date: formatDateOnly(detail.createdAt, tz) })}
          </Link>
        </p>
      )}

      {/* Step 8: actions row */}
      <div className="gp-note-payload__actions">
        <button
          type="button"
          className="gp-btn"
          data-variant="ghost"
          disabled={isDirty || isReclassifying}
          title={isDirty ? t('reclassify_blocked_dirty') : undefined}
          onClick={() => setReclassifyModalOpen(true)}
        >
          {t('action_reclassify')}
        </button>
        <button
          type="button"
          className="gp-btn"
          data-variant="danger"
          // PR #57 F-ARCHIVE-DELETE-BYPASS-DIRTY: disable while content is
          // dirty. handleDelete also calls blockIfDirty() as a second-line
          // check (kept so an automated click handler / a11y override
          // wouldn't slip through).
          disabled={isDirty || savingPatch}
          title={isDirty ? t('action_blocked_dirty') : undefined}
          onClick={handleDelete}
        >
          {t('action_delete')}
        </button>
      </div>

      {/* P7.1 Task 4: separate section from the destructive row above.
          Promote-to-source is a forward / next-step action, not destructive,
          and visually delineated by border-top to make that distinction obvious. */}
      <section className="gp-note-payload__promote-section">
        <button
          type="button"
          className="gp-btn"
          data-variant="ghost"
          onClick={handlePromote}
          disabled={promoteDisabled}
          title={
            detail.archived
              ? t('promote_blocked_archived')
              : isDirty || savingPatch
                ? t('action_blocked_dirty')
                : !detail.content.trim()
                  ? t('promote_empty')
                  : promoteTooShort
                    ? promoteTooShortMessage
                    : undefined
          }
        >
          {promotePending ? '...' : t('action_promote_to_source')}
        </button>
        {promoteError && (
          <p role="alert" className="gp-note-payload__promote-error">
            {promoteErrorMessage}
          </p>
        )}
      </section>

      {/* P7.2: translate trigger section — visible only when note.language
          differs from the current UI locale. Mirrors promote-section's inline
          error pattern so failures stay next to the action that produced them. */}
      {shouldShowTranslate && (
        <section className="gp-note-payload__translate-section">
          <button
            type="button"
            className="gp-btn"
            data-variant="ghost"
            onClick={handleTranslate}
            disabled={translateDisabled}
            title={
              detail?.archived
                ? t('translate_blocked_archived')
                : isDirty || savingPatch
                  ? t('action_blocked_dirty')
                  : !detail?.content.trim()
                    ? t('translate_empty')
                    : undefined
            }
          >
            {translatePending
              ? '...'
              : t('action_translate', { lang: t(`language_label_${locale}`) })}
          </button>
          {translateError && translateErrorMessage && (
            <p role="alert" className="gp-note-payload__translate-error">
              {translateErrorMessage}
            </p>
          )}
        </section>
      )}

      {reclassifyModalOpen && (
        <ReclassifyModal
          isReclassifying={isReclassifying}
          onClose={() => setReclassifyModalOpen(false)}
          onSelect={(intentKey) =>
            void reclassify({
              noteId: id,
              originalContent: currentContent,
              targetIntentKey: intentKey,
              ...(detail.conversationId !== null && { conversationId: detail.conversationId }),
              sessionKey: WEB_SESSION_KEY,
            })
          }
        />
      )}
    </div>
  );
}

interface ReclassifyModalProps {
  /** P5 Fix Batch 7 thread #5: in-flight gate for all four chip buttons.
   * Outer "重新分类" trigger is already gated by `isReclassifying`, but once
   * the modal opens its target buttons share no such state — a quick
   * double-click on a single chip (or clicking two chips in rapid succession)
   * would archive the same note twice and POST `/input` more than once. */
  isReclassifying: boolean;
  onClose: () => void;
  onSelect: (intentKey: string) => void;
}

function ReclassifyModal({ isReclassifying, onClose, onSelect }: ReclassifyModalProps) {
  const t = useTranslations('note_payload');
  // PR #57 F-MODAL-DOM-MISMATCH: refactor to variant 2 of the shared modal
  // primitive (`<button .gp-modal-backdrop>` + sibling `<div .gp-modal>`).
  // The earlier `<div .gp-modal><div .gp-modal__backdrop> + .gp-modal__panel>`
  // structure matched CSS that no longer exists on this branch (only variant
  // 2 ships in modal.css after the redesign) — modal would render unstyled.
  // Disabling the backdrop button during isReclassifying also blocks the
  // "click backdrop while dispatch in flight → expose editor underneath"
  // inline #5 case in the same change.
  return (
    <>
      <button
        type="button"
        className="gp-modal-backdrop"
        onClick={onClose}
        aria-label={t('reclassify_dismiss')}
        disabled={isReclassifying}
      />
      <div className="gp-modal" role="dialog" aria-modal="true">
        <div className="gp-modal__head">
          <h3 className="gp-modal__title">{t('reclassify_title')}</h3>
          <p className="gp-modal__sub">{t('reclassify_hint')}</p>
        </div>
        <div className="gp-modal__foot">
          <button type="button" disabled={isReclassifying} onClick={() => onSelect('query')}>
            {t('reclassify_to_query')}
          </button>
          <button type="button" disabled={isReclassifying} onClick={() => onSelect('submit_text')}>
            {t('reclassify_to_submit')}
          </button>
          <button
            type="button"
            disabled={isReclassifying}
            onClick={() => onSelect('create_tracking')}
          >
            {t('reclassify_to_tracking')}
          </button>
          <button type="button" disabled={isReclassifying} onClick={onClose}>
            {t('reclassify_keep_note')}
          </button>
        </div>
      </div>
    </>
  );
}
