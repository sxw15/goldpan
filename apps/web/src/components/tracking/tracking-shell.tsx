'use client';

import type { CreateInterestInput, InterestListItem } from '@goldpan/web-sdk';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { useInspectorUrlSync } from '../../hooks/use-inspector-url-sync';
import { INSPECTOR_KIND_I18N_KEY, TRACKING_KINDS } from '../../lib/inspector-kinds';
import { useConfirm } from '../confirm-provider';
import { Inspector } from '../inspector/inspector';
import type { PayloadAction, PayloadCapabilitySet } from '../inspector/payloads/types';
import type { SectionResult } from '../library/library-shell';
import { InterestsSection } from './interests-section';

/**
 * Action capabilities declared by TrackingShell. `trackFromEntity` is
 * intentionally excluded: EntityPayload nested via an InterestPayload
 * linked-entity chip must NOT render the "追踪此主题" CTA here — the
 * dispatcher has no case for it and clicking would be a dead click.
 * Module-level readonly to keep Set identity stable across renders.
 */
const TRACKING_CAPABILITIES: PayloadCapabilitySet = new Set<PayloadAction['type']>([
  'updateInterest',
  'deleteInterest',
  'setInterestEnabled',
]);

interface TrackingShellProps {
  interestsResult: SectionResult<InterestListItem>;
  /**
   * When true, render the prominent "尚未配置 Search Tool" banner above the
   * stats / list. The page-level component controls this — V1 leaves it off
   * until a server-side probe lands; the prop keeps the redesign visual ready
   * for the wiring without forcing a backend round-trip yet.
   */
  searchToolWarning?: boolean;
}

export function TrackingShell({ interestsResult, searchToolWarning = false }: TrackingShellProps) {
  const { payload, open, close } = useInspectorUrlSync(TRACKING_KINDS);
  const router = useRouter();
  const t = useTranslations('tracking');
  const tCommon = useTranslations('common');
  const tInspector = useTranslations('inspector');
  const confirm = useConfirm();

  const [interestsOverride, setInterestsOverride] = useState<InterestListItem[] | null>(null);
  const baseInterests = 'ok' in interestsResult ? interestsResult.ok : null;
  const effectiveInterests = interestsOverride ?? baseInterests;

  // biome-ignore lint/correctness/useExhaustiveDependencies: baseInterests is a reference sentinel — drop stale override when server data changes.
  useEffect(() => {
    setInterestsOverride(null);
  }, [baseInterests]);

  const [showNewForm, setShowNewForm] = useState(false);
  const [createWarning, setCreateWarning] = useState<string | null>(null);

  const searchParams = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    const stripped = new URLSearchParams(searchParams);
    stripped.delete('new');
    const qs = stripped.toString();
    router.replace(qs ? `/tracking?${qs}` : '/tracking');
    if (!searchToolWarning) setShowNewForm(true);
  }, [searchParams, router, searchToolWarning]);

  useEffect(() => {
    if (searchToolWarning) setShowNewForm(false);
  }, [searchToolWarning]);

  const handleAction = useCallback(
    async (action: PayloadAction): Promise<void> => {
      const client = getBrowserApiClient();
      switch (action.type) {
        case 'deleteInterest': {
          if (
            !(await confirm({
              message: t('confirm_delete'),
              confirmLabel: tCommon('delete'),
              danger: true,
            }))
          ) {
            return;
          }
          await client.deleteInterest(action.id);
          setInterestsOverride((prev) => {
            const base = prev ?? baseInterests;
            return base ? base.filter((i) => i.id !== action.id) : prev;
          });
          close();
          return;
        }
        case 'setInterestEnabled': {
          if (action.enabled) {
            await client.enableInterest(action.id);
          } else {
            await client.disableInterest(action.id);
          }
          setInterestsOverride((prev) => {
            const base = prev ?? baseInterests;
            return base
              ? base.map((i) => (i.id === action.id ? { ...i, enabled: action.enabled } : i))
              : prev;
          });
          return;
        }
        case 'updateInterest': {
          const updated = await client.updateInterest(action.id, action.patch);
          setInterestsOverride((prev) => {
            const base = prev ?? baseInterests;
            return base ? base.map((i) => (i.id === action.id ? { ...i, ...updated } : i)) : prev;
          });
          return;
        }
        default:
          return;
      }
    },
    [baseInterests, close, confirm, t, tCommon],
  );

  const handleCreate = useCallback(
    async (data: CreateInterestInput) => {
      const client = getBrowserApiClient();
      const created = await client.createInterest(data);
      try {
        const refetched = await client.getInterests();
        setInterestsOverride(refetched.data);
        setCreateWarning(null);
      } catch {
        setInterestsOverride((prev) => {
          const base = prev ?? baseInterests ?? [];
          // Optimistic stats: a freshly-created interest has zero executions
          // by definition, so all aggregates are zero-filled. The next
          // refresh from the server will pull the real values.
          const optimistic: InterestListItem = {
            ...created,
            linkedEntityCount: 0,
            totalHits: 0,
            newHits24h: 0,
            ingestedTotal: 0,
            sparkline: new Array(14).fill(0),
          };
          return [...base, optimistic];
        });
        setCreateWarning(t('create_refetch_failed'));
      }
      setShowNewForm(false);
      router.replace(`/tracking?focus=${created.id}&kind=interest`);
    },
    [router, baseInterests, t],
  );

  const effectiveResult: SectionResult<InterestListItem> =
    effectiveInterests && 'ok' in interestsResult ? { ok: effectiveInterests } : interestsResult;

  return (
    <div className="gp-tracking-shell gp-track-page">
      {createWarning && (
        <p role="alert" className="gp-tracking-shell__create-warning">
          <span>{createWarning}</span>
          <button
            type="button"
            className="gp-tracking-shell__warning-dismiss"
            onClick={() => setCreateWarning(null)}
            aria-label={t('dismiss')}
          >
            ✕
          </button>
        </p>
      )}

      {/* Two surfaces show the same gap, depending on whether the user has any
          interests yet:
          - Empty list → EmptyHero replaces the radar copy with a "configure
            first" stance and hides the new-interest CTA, so the only obvious
            next step is the settings link.
          - Non-empty list → keep the row banner (does not block managing
            existing interests, which may have been authored when a tool was
            still configured).
          Hiding the banner in the empty case keeps the page from carrying two
          warnings about the same problem. */}
      {searchToolWarning && effectiveInterests && effectiveInterests.length > 0 && (
        <div className="gp-track-warn" role="status">
          <span className="gp-track-warn__icon">!</span>
          <div className="gp-track-warn__body">
            <b>{t('search_tool_warn_title')}</b> {t('search_tool_warn_body')}
          </div>
          <a className="gp-track-warn__action" href="/settings?group=search">
            {t('search_tool_warn_cta')}
          </a>
        </div>
      )}

      <InterestsSection
        result={effectiveResult}
        showNewForm={showNewForm}
        onToggleNewForm={() => {
          if (searchToolWarning) return;
          setShowNewForm((v) => !v);
        }}
        onSubmitNew={handleCreate}
        onOpenInterest={(id) => open({ kind: 'interest', id })}
        searchToolWarning={searchToolWarning}
      />
      <Inspector
        payload={payload}
        onClose={close}
        backFallbackLabel={tInspector('back_fallback')}
        closeLabel={tInspector('close')}
        getKindLabel={(kind) => tInspector(INSPECTOR_KIND_I18N_KEY[kind])}
        onAction={handleAction}
        capabilities={TRACKING_CAPABILITIES}
      />
    </div>
  );
}
