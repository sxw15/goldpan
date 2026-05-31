import type { InterestListItem } from '@goldpan/web-sdk';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { SectionResult } from '@/components/library/library-shell';
import { TrackingShell } from '@/components/tracking/tracking-shell';
import { createServerClient, probeSearchToolConfigured, rethrowNextErrors } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { TRACKING_KINDS } from '@/lib/inspector-kinds';
import { parseFocusId, parseInspectorKind } from '@/lib/url';

type SearchParams = { focus?: string; kind?: string };

interface TrackingPageProps {
  searchParams: Promise<SearchParams>;
}

export async function generateMetadata({ searchParams }: TrackingPageProps): Promise<Metadata> {
  const { focus, kind: rawKind } = await searchParams;
  const focusId = parseFocusId(focus);
  const t = await getTranslations('metadata');
  if (focusId === null) return { title: t('page_tracking') };

  const kind = parseInspectorKind(rawKind, TRACKING_KINDS, 'interest');
  try {
    const client = await createServerClient();
    if (kind === 'interest') {
      const detail = await client.getInterest(focusId);
      return { title: t('page_tracking_interest_detail', { name: detail.interest.name }) };
    }
    return { title: t('page_tracking') };
  } catch (err) {
    rethrowNextErrors(err);
    console.error('[metadata:tracking] getInterest failed', err);
    return { title: t('page_tracking') };
  }
}

export default async function TrackingPage(_props: TrackingPageProps) {
  await requireAuth();
  const client = await createServerClient();

  // Run interests + search-tool probe in parallel: the probe never throws
  // (returns `null` on failure) so it does not need to be settled separately.
  const [interestsSettled, searchToolProbe] = await Promise.all([
    client.getInterests().then(
      (v) => ({ ok: v.data }) as const,
      (err: unknown) => ({ err }) as const,
    ),
    probeSearchToolConfigured(),
  ]);

  const t = await getTranslations('tracking');
  let interestsResult: SectionResult<InterestListItem>;
  if ('ok' in interestsSettled) {
    interestsResult = { ok: interestsSettled.ok };
  } else {
    console.error('[tracking:page] load interests failed', interestsSettled.err);
    // Security: do NOT pass server Error.message straight to the client — may
    // leak DB paths, connection strings, stack frames. Reuse empty_title as
    // generic user-facing copy (aligned with library-shell pattern).
    interestsResult = { error: t('empty_title') };
  }

  // Banner only triggers when probe positively confirms zero providers.
  // `null` (auth / network failure) leaves the banner off so a transient
  // outage does not drown the page in scary copy.
  const searchToolWarning = searchToolProbe?.configured === false;

  return <TrackingShell interestsResult={interestsResult} searchToolWarning={searchToolWarning} />;
}
