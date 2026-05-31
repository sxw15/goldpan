'use client';

import type { NoteDetail } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserApiClient } from '@/lib/api-client-browser';

const POLL_INTERVAL_MS = 60_000;
const PREVIEW_LENGTH = 80;

function reminderKey(note: Pick<NoteDetail, 'id' | 'dueAt'>): string {
  return `${note.id}:${note.dueAt ?? 'null'}`;
}

/**
 * Library top banner that surfaces memo notes whose dueAt has passed and which
 * haven't yet been marked reminded. Polls every 60s + fires once on mount.
 * Fires Web Notification (per id, deduped) when permission is already granted.
 *
 * No Notification permission ask here — that's done lazily in NotePayload
 * when user first sets a dueAt. Banner-only fallback if denied.
 */
export function DueRemindersBanner() {
  const t = useTranslations('library');
  const [dueNotes, setDueNotes] = useState<NoteDetail[]>([]);
  const notifiedKeysRef = useRef<Set<string>>(new Set());
  const dismissedKeysRef = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    try {
      const result = await getBrowserApiClient().listNotes({
        subtype: 'memo',
        dueBefore: Date.now(),
        hasReminder: true,
        archived: false,
        limit: 20,
      });
      const visibleNotes = result.data.filter((n) => !dismissedKeysRef.current.has(reminderKey(n)));
      setDueNotes(visibleNotes);

      if (typeof window !== 'undefined' && 'Notification' in window) {
        if (window.Notification.permission === 'granted') {
          for (const n of visibleNotes) {
            const key = reminderKey(n);
            if (notifiedKeysRef.current.has(key)) continue;
            try {
              new window.Notification(t('reminder_notification_title'), {
                body: n.content.slice(0, PREVIEW_LENGTH),
                tag: `goldpan-note-${n.id}`,
              });
              notifiedKeysRef.current.add(key);
            } catch {
              // browser may block (e.g. user gesture required) — silent
            }
          }
        }
      }
    } catch {
      // Swallow polling errors — banner just stays empty / stale.
    }
  }, [t]);

  useEffect(() => {
    void poll();
    const id = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [poll]);

  const handleDismiss = useCallback(async (note: NoteDetail) => {
    const key = reminderKey(note);
    try {
      await getBrowserApiClient().markNoteReminded(note.id, { expectedDueAt: note.dueAt ?? 0 });
      dismissedKeysRef.current.add(key);
      setDueNotes((prev) => prev.filter((n) => reminderKey(n) !== key));
    } catch {
      // ignore — next poll will re-show if server-side mark didn't take
    }
  }, []);

  if (dueNotes.length === 0) return null;

  return (
    <section className="gp-due-banner" aria-label={t('due_reminders_label')}>
      {dueNotes.map((n) => (
        <article key={n.id} className="gp-due-banner__item">
          <span className="gp-due-banner__content">{n.content.slice(0, PREVIEW_LENGTH)}</span>
          <button
            type="button"
            className="gp-btn gp-due-banner__dismiss"
            data-variant="ghost"
            onClick={() => void handleDismiss(n)}
          >
            {t('mark_reminded')}
          </button>
        </article>
      ))}
    </section>
  );
}
