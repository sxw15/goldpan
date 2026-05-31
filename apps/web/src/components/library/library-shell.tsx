'use client';

import type { Entity, NoteDetail, SourceListItem, SourceStatusCounts } from '@goldpan/web-sdk';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ToastStack, useToastStack } from '@/components/toast-stack';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { rethrowNextErrors } from '@/lib/rethrow';
import { useInspectorUrlSync } from '../../hooks/use-inspector-url-sync';
import { INSPECTOR_KIND_I18N_KEY, LIBRARY_KINDS } from '../../lib/inspector-kinds';
import { Inspector } from '../inspector/inspector';
import type { PayloadAction, PayloadCapabilitySet } from '../inspector/payloads/types';
import { CategoryRail, useCategoryItems } from './category-rail';
import { DueRemindersBanner } from './due-reminders-banner';
import { EntitiesSection } from './entities-section';
import { NotesSection } from './notes-section';
import { SourcesSection } from './sources-section';

const LIBRARY_CAPABILITIES: PayloadCapabilitySet = new Set<PayloadAction['type']>([
  'discardSource',
  'trackFromEntity',
]);

export type SectionResult<T> = { ok: T[] } | { error: string };

interface LibraryShellProps {
  entitiesResult: SectionResult<Entity>;
  notesResult: SectionResult<NoteDetail>;
  /** Archived notes (page-level fetches `{ archived: true, limit: 30 }` in
   * parallel). Forwarded to NotesSection — when the user picks the archived
   * filter chip, NotesSection renders this list instead of `notesResult.ok`. */
  archivedNotes: NoteDetail[];
  archivedNotesError?: string;
  sourcesResult: SectionResult<SourceListItem>;
  counts: SourceStatusCounts;
  /** True when the secondary (confirmed_empty) sources fetch failed. The
   * main confirmed list still rendered (otherwise sourcesResult would be
   * `{ error }`); this flag lets SourcesSection display an inline degraded
   * notice instead of pretending the fold group is just empty. */
  confirmedEmptyFailed?: boolean;
}

export function LibraryShell({
  entitiesResult,
  notesResult,
  archivedNotes,
  archivedNotesError,
  sourcesResult,
  counts,
  confirmedEmptyFailed,
}: LibraryShellProps) {
  const { payload, open, close } = useInspectorUrlSync(LIBRARY_KINDS);
  const router = useRouter();
  const tInspector = useTranslations('inspector');
  const tLibrary = useTranslations('library');
  const [category, setCategory] = useState<string>('');
  const { toasts, api: toast } = useToastStack();

  const entities = 'ok' in entitiesResult ? entitiesResult.ok : [];
  const categoryItems = useCategoryItems(entities);

  const [sourcesOverride, setSourcesOverride] = useState<SourceListItem[] | null>(null);
  const baseSources = 'ok' in sourcesResult ? sourcesResult.ok : null;
  const effectiveSources = sourcesOverride ?? baseSources;

  // biome-ignore lint/correctness/useExhaustiveDependencies: baseSources is the sentinel — re-run effect when its reference changes.
  useEffect(() => {
    setSourcesOverride(null);
  }, [baseSources]);

  // Latest snapshot read inside handleAction; lets handleAction stay stable across
  // optimistic updates so Inspector's onAction prop identity doesn't churn.
  // useEffect (rather than render-time mutation) keeps the write outside React's
  // render phase — safer under Strict Mode / concurrent rendering.
  const effectiveSourcesRef = useRef(effectiveSources);
  useEffect(() => {
    effectiveSourcesRef.current = effectiveSources;
  });

  const handleAction = useCallback(
    async (action: PayloadAction): Promise<void> => {
      const client = getBrowserApiClient();
      switch (action.type) {
        case 'discardSource': {
          // Optimistic filter; on failure restore the snapshot so the row reappears.
          const snapshot = effectiveSourcesRef.current;
          if (snapshot) {
            setSourcesOverride(snapshot.filter((s) => s.id !== action.id));
          }
          try {
            await client.discardSource(action.id);
            // 4500ms (longer than the 3500ms default) — leaves room for an undo gesture.
            toast.push({ msg: tLibrary('toast_source_discarded'), ttl: 4500 });
            // Re-fetch server data so `counts` reflects the new discarded total.
            router.refresh();
          } catch (err) {
            // NEXT_REDIRECT pass-through: SDK `onUnauthorized` triggers Next's
            // `redirect()` which throws a digest error. Without re-throwing it
            // first, the redirect would be swallowed into a "discard failed"
            // toast and the user would not be sent to /login. `rethrowNextErrors`
            // is a no-op for plain errors so the rollback path still works.
            rethrowNextErrors(err);
            setSourcesOverride(snapshot);
            toast.push({ msg: tLibrary('toast_source_discard_failed'), kind: 'danger' });
            console.error('[library] discardSource failed', err);
            // Re-throw so payload-side handlers (source-payload, note-payload) can
            // surface their inline alert per spec §4.2 — resolving here would let
            // the inspector flip status to 'discarded' while the row reappears.
            throw err;
          }
          return;
        }
        case 'trackFromEntity': {
          const created = await client.createInterest({
            name: action.entityName,
            searchQueries: [action.entityName],
            linkedEntityIds: [action.entityId],
            enabled: false,
          });
          router.push(`/tracking?focus=${created.id}&kind=interest`);
          return;
        }
        default:
          return;
      }
    },
    [router, toast, tLibrary],
  );

  const sourcesResultEffective: SectionResult<SourceListItem> =
    'ok' in sourcesResult && effectiveSources ? { ok: effectiveSources } : sourcesResult;

  const showRail = categoryItems.length > 0;

  return (
    <div className={`gp-library-shell${showRail ? '' : ' gp-library-shell--no-rail'}`}>
      {showRail && (
        <CategoryRail
          items={categoryItems}
          totalCount={entities.length}
          active={category}
          onChange={setCategory}
        />
      )}
      <main className="gp-library-shell__main">
        <DueRemindersBanner />
        <section className="gp-library-shell__section">
          <EntitiesSection
            result={entitiesResult}
            onOpenEntity={(id) => {
              open({ kind: 'entity', id });
            }}
            category={category}
            onCategoryChange={setCategory}
            categoryItems={categoryItems}
          />
        </section>
        <section className="gp-library-shell__section">
          <NotesSection
            result={notesResult}
            archivedNotes={archivedNotes}
            archivedNotesError={archivedNotesError}
            onOpenPayload={(payload) => {
              open(payload);
            }}
          />
        </section>
        <section className="gp-library-shell__section">
          <SourcesSection
            result={sourcesResultEffective}
            onOpenPayload={(payload) => {
              open(payload);
            }}
            category={category}
            onCategoryChange={setCategory}
            counts={counts}
            confirmedEmptyFailed={confirmedEmptyFailed}
          />
        </section>
      </main>
      <Inspector
        payload={payload}
        onClose={close}
        backFallbackLabel={tInspector('back_fallback')}
        closeLabel={tInspector('close')}
        getKindLabel={(kind) => tInspector(INSPECTOR_KIND_I18N_KEY[kind])}
        onAction={handleAction}
        capabilities={LIBRARY_CAPABILITIES}
      />
      <ToastStack toasts={toasts} dismiss={toast.dismiss} closeLabel={tInspector('close')} />
    </div>
  );
}
