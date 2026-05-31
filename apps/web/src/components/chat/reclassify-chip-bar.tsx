'use client';

import { GoldpanApiError, type NoteSubtype } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { getBrowserApiClient } from '@/lib/api-client-browser';

/**
 * P5 N5: lets the user "un-squash" a misread note classification — when the
 * classifier records something as a note but the user really meant a question
 * / submission / tracking rule, the chip bar archives the original note and
 * re-dispatches the same input under a `forcedIntent` so the classifier is
 * bypassed and the correct plugin runs.
 *
 * Dispatch + archive happen inside `useReclassifyNote` (P5 Task 5); this
 * component is the presentation surface and only emits a structured payload
 * via `onReclassify`. `disabled` is wired to the hook's `isReclassifying`
 * flag so chips can't be double-clicked while the round-trip is in flight.
 */
interface ReclassifyChipBarProps {
  noteId: number;
  subtype: NoteSubtype;
  /** The user turn that triggered the note classification — re-submitted as
   * /input.input when the user clicks a chip, so the plugin sees the original
   * text under forcedIntent. Bound at convert time / runIntent success path
   * by chat-view (see `ChatMessage.originalUserContent`). */
  originalContent: string;
  onReclassify: (params: {
    noteId: number;
    originalContent: string;
    targetIntentKey: string;
  }) => void;
  /** Hook `isReclassifying` flag passed through — disables chips while the
   * archive + dispatch round-trip is in flight to prevent double-click. */
  disabled?: boolean;
}

/**
 * Chip targets. `key` is the `forcedIntent` value handed to the server
 * `/input` route — must match an intent registered with the plugin registry
 * (see `@goldpan/core` IntentDeclaration ids). `labelKey` is resolved
 * against the `reclassify_chip_bar` i18n namespace below.
 */
const TARGETS: ReadonlyArray<{ key: string; labelKey: string }> = [
  { key: 'query', labelKey: 'to_query' },
  { key: 'submit_text', labelKey: 'to_submit' },
  { key: 'create_tracking', labelKey: 'to_tracking' },
];

export function ReclassifyChipBar({
  noteId,
  subtype,
  originalContent,
  onReclassify,
  disabled,
}: ReclassifyChipBarProps) {
  const t = useTranslations('reclassify_chip_bar');
  const tLib = useTranslations('library');
  const tChat = useTranslations('chat');
  // PR #57 thread #1: chat-view's per-session `reclassifiedNoteIds` only
  // covers notes reclassified inside the current chat session — if user
  // archives the note from /library inspector and navigates back, the
  // ChipBar is still rendered on the persisted assistant turn. Lazy fetch
  // the note's current archived state on mount and hide self (rendering the
  // same `chat.reclassified_note` hint as the reclassified path) so the
  // user can't double-reclassify an already-archived note.
  const [hiddenByArchive, setHiddenByArchive] = useState(false);
  const [archiveProbePending, setArchiveProbePending] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setHiddenByArchive(false);
    setArchiveProbePending(true);
    getBrowserApiClient()
      .getNote(noteId)
      .then((note) => {
        if (cancelled) return;
        setHiddenByArchive(note.archived);
        setArchiveProbePending(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // PR #57 F-CHIPBAR-SILENT-404: discriminate 404 / 410 (note was
        // deleted) from other errors. Deleted notes share the same UX
        // as archived ones — chip bar disappears so the user can't queue
        // an archive PATCH that's guaranteed to 404. Other errors keep
        // the chips visible (server may be transiently down) and log
        // with context so the failure is debuggable.
        if (err instanceof GoldpanApiError && (err.status === 404 || err.status === 410)) {
          setHiddenByArchive(true);
          setArchiveProbePending(false);
          return;
        }
        console.error('[ReclassifyChipBar] note state probe failed', { noteId, err });
        setArchiveProbePending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  if (hiddenByArchive) {
    return (
      <p
        className="gp-message-bubble__reclassified-hint"
        data-testid="reclassify-chip-bar-archived"
      >
        {tChat('reclassified_note')}
      </p>
    );
  }
  return (
    <div className="gp-reclassify-chip-bar" data-testid="reclassify-chip-bar">
      <span className="gp-reclassify-chip-bar__current">
        {t('saved_as', { subtype: tLib(`notes_subtype_${subtype}`) })}
      </span>
      <span className="gp-reclassify-chip-bar__dot" aria-hidden>
        ·
      </span>
      {TARGETS.map((tgt) => (
        <button
          key={tgt.key}
          type="button"
          className="gp-chip gp-reclassify-chip-bar__chip"
          disabled={disabled || archiveProbePending || !originalContent}
          onClick={() => {
            // Guard mirrors `disabled={!originalContent}` for defense-in-depth
            // against synthetic clicks; native disabled covers the visual path.
            if (disabled || archiveProbePending || !originalContent) return;
            onReclassify({ noteId, originalContent, targetIntentKey: tgt.key });
          }}
        >
          {t(tgt.labelKey)}
        </button>
      ))}
    </div>
  );
}
