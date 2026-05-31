import type {
  Entity,
  NoteDetail,
  SourceListItem,
  SourceListResponse,
  SourceStatusCounts,
} from '@goldpan/web-sdk';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LibraryShell, type SectionResult } from '@/components/library/library-shell';
import { createServerClient, rethrowNextErrors } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { LIBRARY_KINDS } from '@/lib/inspector-kinds';
import { parseFocusId, parseInspectorKind } from '@/lib/url';

type SearchParams = { focus?: string; kind?: string };
interface LibraryPageProps {
  searchParams: Promise<SearchParams>;
}

export async function generateMetadata({ searchParams }: LibraryPageProps): Promise<Metadata> {
  const { focus, kind: rawKind } = await searchParams;
  const focusId = parseFocusId(focus);
  const t = await getTranslations('metadata');
  if (focusId === null) return { title: t('page_library') };

  const kind = parseInspectorKind(rawKind, LIBRARY_KINDS, 'entity');
  try {
    const client = await createServerClient();
    if (kind === 'entity') {
      const detail = await client.getEntity(focusId);
      return { title: t('page_library_entity_detail', { name: detail.entity.name }) };
    }
    if (kind === 'note') {
      const detail = await client.getNote(focusId);
      const preview =
        detail.content.length > 30 ? `${detail.content.slice(0, 30)}…` : detail.content;
      return { title: t('page_library_note_detail', { preview }) };
    }
    // kind === 'source' — Library Inspector renders the full source-detail
    // view (SourceViewPayload) under 'source'. getSourceView returns the
    // richer payload that includes the same title fallback as SourceDetail.
    const detail = await client.getSourceView(focusId);
    const name = detail.source.title ?? detail.source.originalUrl ?? `#${focusId}`;
    return { title: t('page_library_source_detail', { name }) };
  } catch (err) {
    rethrowNextErrors(err);
    // Other failures (5xx / network): the page body's error boundary handles
    // rendering, but we still return a usable title so the browser tab
    // doesn't end up blank.
    console.error('[metadata:library] get* failed', err);
    return { title: t('page_library') };
  }
}

// Use two-arg `.then(ok, err)` to keep each fetch's error isolated to its own
// envelope, then await all envelopes via Promise.all. This pattern (vs
// Promise.allSettled) gives strongly-typed success/failure unions per request
// without per-call `if (settled.status === 'fulfilled')` ladder noise.
type SourcesEnvelope = { ok: SourceListResponse } | { error: unknown };
type NotesEnvelope = { ok: NoteDetail[] } | { error: unknown };

const ZERO_COUNTS: SourceStatusCounts = {
  processing: 0,
  confirmed: 0,
  confirmed_empty: 0,
  failed: 0,
  discarded: 0,
};

export default async function LibraryPage(_props: LibraryPageProps) {
  await requireAuth();
  const client = await createServerClient();
  const t = await getTranslations('library');

  // Security: do NOT pass `reason.message` straight to the front-end. Server
  // errors can embed DB paths, connection strings, or internal stack traces,
  // which would leak to anyone who can reach /library. Use fixed i18n copy
  // for the user; send the raw reason to `console.error` for server logs.
  //
  // Split confirmed (main list) and confirmed_empty (collapsed group) into two
  // requests so a burst of empty sources can't push older confirmed rows past
  // a shared `limit`. Each call returns the same global statusCounts; we read
  // it from the confirmed response (or fall back to confirmed_empty).
  //
  // Similarly split active notes (archived=false, the main list) from
  // archived notes (archived=true, lazy fold). Sharing one fetch would either
  // mix archived rows back into the subtype counts (confusing) or require
  // post-filtering in the component, which doesn't help the limit-truncation
  // edge case. archived has a smaller limit (30) — it's a secondary view.
  //
  // 二轮 review N8: 5 个独立 SSR 拉取并行（entities / active notes /
  // archived notes / confirmed sources / confirmed_empty），避免 sequential
  // await 拖慢首屏。
  // C5: every error handler must call rethrowNextErrors(err) BEFORE building
  // the envelope. `requireAuth` / SDK `onUnauthorized` use Next's `redirect()`
  // (which throws NEXT_REDIRECT); if we swallow that here the redirect dies
  // silently and the user sees a fake "load failed" tile. `unstable_rethrow`
  // is a no-op for plain GoldpanApiError, so the degraded path still works.
  const [entitiesResult, notesResult, archivedEnvelope, confirmedEnvelope, emptyEnvelope] =
    await Promise.all([
      client.getEntities().then(
        (r): SectionResult<Entity> => ({ ok: r.data }),
        (err): SectionResult<Entity> => {
          rethrowNextErrors(err);
          console.error('[library:page] load entities failed', err);
          return { error: t('section_load_failed_entities') };
        },
      ),
      client.listNotes({ archived: false, limit: 100 }).then(
        (r): SectionResult<NoteDetail> => ({ ok: r.data }),
        (err): SectionResult<NoteDetail> => {
          rethrowNextErrors(err);
          console.error('[library:page] load notes failed', err);
          return { error: t('section_load_failed_notes') };
        },
      ),
      client.listNotes({ archived: true, limit: 30 }).then(
        (r): NotesEnvelope => ({ ok: r.data }),
        (err): NotesEnvelope => {
          rethrowNextErrors(err);
          return { error: err };
        },
      ),
      client.listSources({ status: ['confirmed'], limit: 100 }).then(
        (r): SourcesEnvelope => ({ ok: r }),
        (err): SourcesEnvelope => {
          rethrowNextErrors(err);
          return { error: err };
        },
      ),
      client.listSources({ status: ['confirmed_empty'], limit: 30 }).then(
        (r): SourcesEnvelope => ({ ok: r }),
        (err): SourcesEnvelope => {
          rethrowNextErrors(err);
          return { error: err };
        },
      ),
    ]);

  let archivedNotes: NoteDetail[];
  let archivedNotesError: string | undefined;
  if ('ok' in archivedEnvelope) {
    archivedNotes = archivedEnvelope.ok;
  } else {
    console.error('[library:page] load archived notes failed', archivedEnvelope.error);
    archivedNotes = [];
    archivedNotesError = t('section_load_failed_archived_notes');
  }

  let sourcesResult: SectionResult<SourceListItem>;
  let counts: SourceStatusCounts = ZERO_COUNTS;
  let confirmedEmptyFailed = false;
  if ('ok' in confirmedEnvelope) {
    counts = confirmedEnvelope.ok.counts;
    // confirmed_empty is a secondary collapsed view — a failure there shouldn't
    // blank the main list, so we degrade to "no fold group" and surface a
    // small inline notice (confirmedEmptyFailed) so the user knows the empty
    // group may be incomplete instead of pretending it's just empty.
    let empties: SourceListItem[];
    if ('ok' in emptyEnvelope) {
      empties = emptyEnvelope.ok.data;
    } else {
      console.error('[library:page] load confirmed_empty failed', emptyEnvelope.error);
      empties = [];
      confirmedEmptyFailed = true;
    }
    sourcesResult = { ok: [...confirmedEnvelope.ok.data, ...empties] };
  } else {
    console.error('[library:page] load confirmed sources failed', confirmedEnvelope.error);
    sourcesResult = { error: t('section_load_failed_sources') };
  }

  return (
    <LibraryShell
      entitiesResult={entitiesResult}
      notesResult={notesResult}
      archivedNotes={archivedNotes}
      archivedNotesError={archivedNotesError}
      sourcesResult={sourcesResult}
      counts={counts}
      confirmedEmptyFailed={confirmedEmptyFailed}
    />
  );
}
