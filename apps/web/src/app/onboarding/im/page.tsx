// Server wrapper — fetches IM channel manifests for the wizard step. The
// client-side step lives in `./page-client.tsx`. We soft-fail on fetch error
// (default empty array) so the onboarding flow doesn't crash if the wizard
// server hasn't exposed `/settings/im/manifests` (currently the wizard server
// only registers it via `createImSettingsRoutes` in normal mode — see
// `apps/server/src/wizard-server.ts`). When manifests are empty the IM step
// renders zero channels which is a usable degraded state — users can revisit
// IM config from `/settings/notify` after the wizard completes.
import type { ImSettingsManifest } from '@goldpan/web-sdk';
import { createServerClient } from '@/lib/api';
import { ImPageClient } from './page-client';

export default async function ImPage() {
  const client = await createServerClient();
  let manifests: ImSettingsManifest[] = [];
  try {
    const res = await client.getImSettingsManifests();
    manifests = res.manifests;
  } catch (err) {
    // Wizard server doesn't expose this route yet — fall through with empty
    // array so the wizard step still renders. Surface to logs so deployers
    // can see why the IM step is empty if they expected channels.
    console.error('[onboarding/im] manifests fetch failed', err);
  }
  return <ImPageClient manifests={manifests} />;
}
