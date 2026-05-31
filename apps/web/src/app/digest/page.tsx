import { GoldpanApiError } from '@goldpan/web-sdk';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { DisabledView } from '@/components/digest/disabled-view';
import {
  createServerClient,
  isPluginDisabled,
  listDigestPresetsCached,
  rethrowNextErrors,
} from '@/lib/api';
import { yesterdayLocal } from '@/lib/format';
import { getEffectiveTimezone } from '@/lib/tz-fetch';
import { PreviewClient } from './PreviewClient';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return { title: t('page_digest') };
}

export default async function DigestPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; presetId?: string; channel?: string }>;
}) {
  const params = await searchParams;
  const channel = params.channel ?? 'web';
  // Goes through the cached helper so the layout's nav-badge probe and this
  // page share a single GET /digest/presets per request. A direct
  // `client.listDigestPresets()` call here would bypass that cache.
  const cached = await listDigestPresetsCached(channel);
  if (cached.kind === 'unauthenticated') redirect('/login');
  if (cached.kind === 'plugin_disabled') {
    return (
      <main className="gp-digest-page">
        <DisabledView channel={channel} />
      </main>
    );
  }
  if (cached.kind === 'error') {
    rethrowNextErrors(cached.err);
    if (cached.err instanceof GoldpanApiError && cached.err.status === 404) return notFound();
    throw cached.err;
  }
  const presets = cached.presets;
  const client = await createServerClient();
  const selected =
    presets.find((p) => String(p.id) === params.presetId) ??
    presets.find((p) => p.isDefault) ??
    presets[0] ??
    null;
  let preview: Awaited<ReturnType<typeof client.getDigestPreview>> | null = null;
  try {
    preview = await client.getDigestPreview({
      channel,
      ...(params.date ? { date: params.date } : {}),
      ...(selected?.id !== undefined ? { presetId: selected.id } : {}),
    });
  } catch (err) {
    rethrowNextErrors(err);
    // A missing snapshot comes back as 200 with `status: 'missing'` (see
    // route handler), not an error. plugin_disabled on this call means the
    // plugin was toggled off between listDigestPresets and now — render the
    // disabled notice for consistency. Anything else is a real failure.
    if (isPluginDisabled(err)) {
      return (
        <main className="gp-digest-page">
          <DisabledView channel={channel} />
        </main>
      );
    }
    throw err;
  }
  // Effective date for the toolbar — needed even when snapshot is missing so
  // the user can step back to a date that has data instead of being locked
  // into an empty page. Mirrors the server-side `getDigestPreview` default
  // (yesterday UTC) when no explicit date param is given.
  const tz = await getEffectiveTimezone();
  const effectiveDate = preview?.snapshot?.digestId.date ?? params.date ?? yesterdayLocal(tz);
  return (
    <main className="gp-digest-page">
      <PreviewClient
        channel={channel}
        presets={presets}
        selectedPresetId={selected?.id ?? null}
        initialPreview={preview}
        initialDate={params.date ?? null}
        effectiveDate={effectiveDate}
      />
    </main>
  );
}
