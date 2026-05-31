'use client';

import {
  Bell,
  Boxes,
  ChevronRight,
  Cpu,
  Database,
  Download,
  type LucideIcon,
  Newspaper,
  Plug,
  Search,
  Server,
  SunMedium,
  User,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { SettingsGroupId } from './settings-data';

export const GROUP_ICONS: Record<SettingsGroupId, LucideIcon> = {
  account: User,
  data: Database,
  appearance: SunMedium,
  llm: Cpu,
  embedding: Boxes,
  plugins: Plug,
  collect: Download,
  search: Search,
  notify: Bell,
  digest: Newspaper,
  about: Server,
};

export const ChevronIcon = ChevronRight;

/**
 * Three-state pill that surfaces the origin of an env key's live value:
 *   - `env`     → boot baseline (.env / docker / k8s injection)
 *   - `override` → DB-persisted runtime override (commit just persisted)
 *   - `default` → no baseline and no override; schema fallback or unset
 *
 * Used as a visual cue next to each settings row so the user can tell at
 * a glance which keys are live overrides (and therefore reversible via the
 * Reset button) vs which keys are coming from the boot environment.
 *
 * `baselineDiffers` is meaningful only for `source === 'override'` — it
 * indicates that the env baseline ALSO defines a non-empty value but the
 * live override disagrees. We surface this two ways so the warning lands
 * for every modality:
 *
 *   - sighted users get a `!` glyph + a hover `title` hint
 *   - assistive tech gets a `gp-sr-only` span carrying the same hint as
 *     readable text (HTML `title` attributes are unreliable in screen
 *     readers and entirely invisible on touch devices)
 *
 * The outer `<span role="status">` makes the whole badge a discoverable
 * landmark so the screen reader announces the source label + optional
 * divergence hint together, instead of treating them as inline noise.
 */
export function OriginBadge({
  source,
  baselineDiffers,
}: {
  source: 'env' | 'override' | 'default';
  baselineDiffers?: boolean;
}) {
  const t = useTranslations('settings.origin');
  const labelMap = {
    env: t('env'),
    override: t('override'),
    default: t('default'),
  } as const;
  const hint = baselineDiffers ? t('baseline_differs_hint') : undefined;
  return (
    <span
      className={`gp-origin-badge gp-origin-badge--${source}`}
      title={hint}
      role={baselineDiffers ? 'status' : undefined}
    >
      {labelMap[source]}
      {baselineDiffers ? (
        <>
          <span className="gp-origin-badge__diff-mark" aria-hidden="true">
            !
          </span>
          <span className="gp-sr-only">{hint}</span>
        </>
      ) : null}
    </span>
  );
}
