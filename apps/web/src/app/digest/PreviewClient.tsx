'use client';
import type { DigestPreset, DigestRenderPreset, DigestSnapshotResponse } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { DigestShell } from '@/components/digest/digest-shell';
import { DigestToolbar } from '@/components/digest/digest-toolbar';
import { ShareDialog } from '@/components/digest/share-dialog';
import { ToastStack, useToastStack } from '@/components/toast-stack';
import { createDigestShareLink, previewDigest, regenerateDigest } from './actions';

/** Project a full preset down to the render-only subset DigestSections needs. */
function toRenderPreset(p: DigestPreset | undefined): DigestRenderPreset | null {
  if (!p) return null;
  return {
    slots: p.slots,
    skipEmpty: p.skipEmpty,
    includeAiSummary: p.includeAiSummary,
    period: p.period,
  };
}

interface Props {
  channel: string;
  presets: DigestPreset[];
  selectedPresetId: number | null;
  initialPreview: DigestSnapshotResponse | null;
  /**
   * The date (`YYYY-MM-DD`, UTC) this page was loaded for. Threaded through to
   * every regenerate call so preset-switching / regenerate buttons stay on the
   * same day instead of jumping back to today's server-default "yesterday".
   * `null` means the caller is viewing the default page with no explicit date.
   */
  initialDate: string | null;
  /**
   * Always-resolved YYYY-MM-DD for the toolbar — falls back to yesterday-UTC
   * when neither the snapshot nor the URL supplies one. Without this the
   * toolbar would unmount on a missing snapshot, locking the user out of the
   * date stepper and making it impossible to navigate back to a populated day.
   */
  effectiveDate: string;
}

interface ShareState {
  open: boolean;
  loading: boolean;
  url: string | null;
  ttlDays: number | null;
  unavailable: boolean;
}

const SHARE_INITIAL: ShareState = {
  open: false,
  loading: false,
  url: null,
  ttlDays: null,
  unavailable: false,
};

export function PreviewClient({
  channel,
  presets,
  selectedPresetId,
  initialPreview,
  initialDate,
  effectiveDate,
}: Props) {
  const t = useTranslations('digest');
  const [preview, setPreview] = useState(initialPreview);
  const [presetId, setPresetId] = useState<number | null>(selectedPresetId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [share, setShare] = useState<ShareState>(SHARE_INITIAL);
  const [isPending, start] = useTransition();
  const { toasts, api: toast } = useToastStack();

  // Re-sync local state with the freshly server-rendered props when the URL
  // navigates (date / presetId changes via Link). useState only seeds on
  // mount, so without this hook the prev/next date stepper changes the URL
  // and re-fetches on the server but the client keeps showing the previous
  // snapshot — locking the toolbar onto a stale date. We intentionally key
  // on URL-derived values (initialDate / selectedPresetId), not
  // `initialPreview`: action-driven setPreview must not be clobbered by a
  // re-render where the prop reference differs but the URL didn't change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    setPreview(initialPreview);
    setPresetId(selectedPresetId);
    setErrorMessage(null);
    setShare(SHARE_INITIAL);
  }, [initialDate, selectedPresetId]);

  const snapshot = preview?.snapshot ?? null;
  const toolbarDate = snapshot?.digestId.date ?? effectiveDate;

  const onShare = useCallback(() => {
    setShare({ open: true, loading: true, url: null, ttlDays: null, unavailable: false });
    start(async () => {
      const res = await createDigestShareLink({
        channel,
        date: toolbarDate,
        presetId: presetId ?? null,
      });
      if (res.ok) {
        setShare({
          open: true,
          loading: false,
          url: res.url,
          ttlDays: res.ttlDays,
          unavailable: false,
        });
      } else if (res.code === 'share_link_disabled') {
        setShare({
          open: true,
          loading: false,
          url: null,
          ttlDays: null,
          unavailable: true,
        });
      } else {
        setShare(SHARE_INITIAL);
        toast.push({
          msg: t('toast_share_link_failed', { message: res.message }),
          kind: 'danger',
        });
      }
    });
  }, [channel, toolbarDate, presetId, toast, t]);

  const onShareCopy = useCallback(() => {
    // ShareDialog's useCopyToClipboard already wrote — only invoked on
    // success, so this just surfaces the confirmation toast.
    toast.push({ msg: t('toast_share_link_copied'), kind: 'success' });
  }, [toast, t]);

  return (
    <div className="gp-digest-page__container">
      <DigestToolbar
        channel={channel}
        presets={presets}
        presetId={presetId}
        period={snapshot?.period ?? null}
        date={toolbarDate}
        generatedAt={snapshot?.generatedAt ?? null}
        status={preview?.status ?? null}
        isPending={isPending}
        onChangePreset={(next) => {
          setPresetId(next);
          // Preset switches re-render the same stored snapshot with the
          // new preset's slot order + skipEmpty — they do NOT need to
          // force-regenerate (and must not, since that would burn an
          // LLM call per dropdown change).
          start(async () => {
            setErrorMessage(null);
            const res = await previewDigest(channel, next ?? undefined, initialDate);
            if (!res.ok) {
              setErrorMessage(res.message);
              return;
            }
            setPreview(res.preview);
          });
        }}
        onRegenerate={() => {
          toast.push({ msg: t('toast_regenerating') });
          start(async () => {
            setErrorMessage(null);
            const res = await regenerateDigest(channel, presetId ?? undefined, initialDate);
            if (!res.ok) {
              setErrorMessage(res.message);
              toast.push({
                msg: t('toast_regenerate_failed', { message: res.message }),
                kind: 'danger',
              });
              return;
            }
            setPreview(res.preview);
            toast.push({ msg: t('toast_regenerated'), kind: 'success' });
          });
        }}
        onShare={onShare}
      />
      {errorMessage ? (
        <div role="alert" className="gp-digest-page__error">
          {errorMessage}
        </div>
      ) : null}
      {snapshot ? (
        <DigestShell
          snapshot={snapshot}
          preset={toRenderPreset(presets.find((p) => p.id === presetId))}
          channel={channel}
        />
      ) : (
        <p className="gp-digest-page__empty">{t('empty')}</p>
      )}
      <ShareDialog
        open={share.open}
        url={share.url}
        ttlDays={share.ttlDays}
        unavailable={share.unavailable}
        loading={share.loading}
        onClose={() => setShare(SHARE_INITIAL)}
        onCopy={onShareCopy}
      />
      <ToastStack toasts={toasts} dismiss={toast.dismiss} closeLabel={t('toast_close_label')} />
    </div>
  );
}
