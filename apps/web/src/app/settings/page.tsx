import {
  type DigestPreset,
  type EnvKeyState,
  GoldpanApiError,
  type ImSettingsManifest,
  type PluginSettingsContributionDescriptor,
  type PluginsSnapshot,
} from '@goldpan/web-sdk';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { createServerClient, listDigestPresetsCached, rethrowNextErrors } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { SettingsShell } from './settings-shell';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return { title: t('page_settings') };
}

export default async function SettingsPage() {
  await requireAuth();

  // Share the cached preset listing with the layout's nav-badge probe so the
  // settings page render doesn't issue a second `GET /digest/presets` per
  // navigation. The discriminated union collapses to: `unauthenticated` →
  // /login (requireAuth above already ran, but pre-login edges can still hit
  // here), `plugin_disabled` → render with empty presets, `error` → 404 or
  // bubble.
  const client = await createServerClient();
  // Locale comes from next-intl/server (cookie-or-env resolution lives in
  // src/i18n/request.ts); only 'en' / 'zh' are valid targets, but cast
  // defensively so a stale cookie / future locale doesn't crash the cast.
  const rawLocale = await getLocale();
  const language: 'en' | 'zh' = rawLocale === 'zh' ? 'zh' : 'en';
  const [
    cached,
    envStateResult,
    manifestsResult,
    pluginsResult,
    contributionsResult,
    healthResult,
  ] = await Promise.all([
    listDigestPresetsCached('web'),
    client.getEnvState().catch((err: unknown) => ({ __error: err as unknown })),
    client.getImSettingsManifests().catch((err: unknown) => ({ __error: err as unknown })),
    client.listPlugins(language).catch((err: unknown) => ({ __error: err as unknown })),
    client
      .getSettingsContributions(language)
      .catch((err: unknown) => ({ __error: err as unknown })),
    client.health().catch((err: unknown) => ({ __error: err as unknown })),
  ]);

  if (cached.kind === 'unauthenticated') redirect('/login');

  let presets: DigestPreset[] = [];
  let digestEnabled = true;
  if (cached.kind === 'ok') {
    presets = cached.presets;
  } else if (cached.kind === 'plugin_disabled') {
    digestEnabled = false;
  } else {
    rethrowNextErrors(cached.err);
    if (cached.err instanceof GoldpanApiError && cached.err.status === 404) return notFound();
    throw cached.err;
  }

  // Env state failure should NOT take down the whole page — render with empty
  // items so users can still inspect digest preset / mock fields. Shell shows
  // a toast banner explaining env couldn't load.
  let envItems: EnvKeyState[] = [];
  let envStateError: string | null = null;
  if ('__error' in envStateResult) {
    const err = envStateResult.__error;
    if (err instanceof GoldpanApiError && err.status === 401) redirect('/login');
    envStateError = err instanceof Error ? err.message : 'unknown';
  } else {
    envItems = envStateResult.items;
  }

  // Manifests failure should NOT take down the whole page — fall back to empty
  // array and surface via the same envStateError banner channel (single toast
  // slot covers both fetch failures sharing the same root cause: the standalone
  // server is unreachable).
  let manifests: ImSettingsManifest[] = [];
  if ('__error' in manifestsResult) {
    const err = manifestsResult.__error;
    if (err instanceof GoldpanApiError && err.status === 401) redirect('/login');
    if (envStateError === null) {
      envStateError = err instanceof Error ? err.message : 'unknown';
    }
  } else {
    manifests = manifestsResult.manifests;
  }

  // Plugins-snapshot failure also degrades gracefully: render an empty plugin
  // list and surface via a dedicated `pluginsError` slot so the user can see
  // both the env-state error and the plugin error concurrently if both fail.
  let pluginsSnapshot: PluginsSnapshot = { plugins: [], registryInstallSupported: false };
  let pluginsError: string | null = null;
  if ('__error' in pluginsResult) {
    const err = pluginsResult.__error;
    if (err instanceof GoldpanApiError && err.status === 401) redirect('/login');
    pluginsError = err instanceof Error ? err.message : 'unknown';
  } else {
    pluginsSnapshot = pluginsResult;
  }

  // Plugin settings contributions — new generic protocol. Falls back to empty
  // list; failures surface via the existing envStateError banner (root cause
  // is shared with manifests / env-state: the standalone server is down).
  let contributions: PluginSettingsContributionDescriptor[] = [];
  let contributionsError: string | null = null;
  if ('__error' in contributionsResult) {
    const err = contributionsResult.__error;
    if (err instanceof GoldpanApiError && err.status === 401) redirect('/login');
    contributionsError = err instanceof Error ? err.message : 'unknown';
    if (envStateError === null) {
      envStateError = contributionsError;
    }
  } else {
    contributions = contributionsResult.contributions;
  }

  let initialPendingRestartKeys: string[] = [];
  if ('__error' in healthResult) {
    const err = healthResult.__error;
    if (err instanceof GoldpanApiError && err.status === 401) redirect('/login');
  } else if (healthResult.status !== 'wizard') {
    initialPendingRestartKeys = healthResult.pendingRestartKeys;
  }

  return (
    <main className="gp-settings-page">
      <SettingsShell
        initialDigestEnabled={digestEnabled}
        initialPresets={presets}
        initialEnvItems={envItems}
        envStateError={envStateError}
        manifests={manifests}
        contributions={contributions}
        contributionsError={contributionsError}
        language={language}
        initialPluginsSnapshot={pluginsSnapshot}
        pluginsError={pluginsError}
        initialPendingRestartKeys={initialPendingRestartKeys}
      />
    </main>
  );
}
